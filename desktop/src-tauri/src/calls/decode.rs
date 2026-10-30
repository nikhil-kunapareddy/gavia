//! Decoding recordings into mono samples, a packet at a time.
//!
//! A long recording never exists in memory as samples: [`Recording`] hands
//! out each decoded packet, downmixed, and the caller cuts windows from them as
//! they arrive. Peak memory is the encoded file plus one window, however long
//! the recording is.
//!
//! Samples match what the Python pipeline read through libsndfile: integers
//! scale by a power of two, channels average in `f32` the way NumPy's
//! `mean(axis=1, dtype=float32)` does, and MP3 encoder delay and padding are
//! trimmed (gapless) as mpg123 trims them.

use std::io::Cursor;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{CODEC_TYPE_NULL, Decoder, DecoderOptions};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, FormatReader};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

const SUPPORTED: &str = "Upload a WAV, MP3, FLAC, OGG or M4A recording.";

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum AudioError {
    #[error("{0}")]
    Unsupported(String),
    #[error("{0}")]
    Decode(String),
    #[error("{0}")]
    TooLong(String),
}

/// Containers Gavia reads, told apart by their first bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Container {
    Wav,
    Mp3,
    Flac,
    Ogg,
    /// MP4 family: M4A, and the audio track of an MP4 or MOV video.
    Mp4,
}

impl Container {
    fn extension(self) -> &'static str {
        match self {
            Container::Wav => "wav",
            Container::Mp3 => "mp3",
            Container::Flac => "flac",
            Container::Ogg => "ogg",
            Container::Mp4 => "m4a",
        }
    }
}

/// Trust the file's own header over its name or what the client said.
pub fn sniff(bytes: &[u8]) -> Result<Container, AudioError> {
    if bytes.is_empty() {
        return Err(AudioError::Unsupported(
            "The uploaded file is empty.".into(),
        ));
    }
    let at = |offset: usize, magic: &[u8]| bytes.get(offset..offset + magic.len()) == Some(magic);
    if at(0, b"RIFF") && at(8, b"WAVE") {
        return Ok(Container::Wav);
    }
    if at(0, b"fLaC") {
        return Ok(Container::Flac);
    }
    if at(0, b"OggS") {
        return Ok(Container::Ogg);
    }
    if at(4, b"ftyp") {
        return Ok(Container::Mp4);
    }
    // An ID3 tag, or straight into an MPEG audio frame sync.
    if at(0, b"ID3") || (bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] & 0xE0 == 0xE0) {
        return Ok(Container::Mp3);
    }
    Err(AudioError::Unsupported(format!(
        "This file is not a recording Gavia can read. {SUPPORTED}"
    )))
}

/// An open recording, decoded on demand by [`Recording::next_samples`].
pub struct Recording {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    sample_rate: u32,
    channels: usize,
    /// Mono frames handed out so far, for the duration limit.
    frames: u64,
    max_frames: u64,
    max_seconds: f64,
    /// Encoder priming still to drop from the start (MP4 only; see [`mp4_priming`]).
    skip: usize,
    interleaved: Option<SampleBuffer<f32>>,
    mono: Vec<f32>,
}

impl Recording {
    /// Probe `bytes` and get ready to decode, refusing anything longer than
    /// `max_seconds` up front when the header says how long it is.
    pub fn open(bytes: &[u8], max_seconds: f64) -> Result<Self, AudioError> {
        let container = sniff(bytes)?;
        // The stream must own its bytes ('static), so this is one copy of the
        // encoded file; the decoded audio is never held whole.
        let source =
            MediaSourceStream::new(Box::new(Cursor::new(bytes.to_vec())), Default::default());
        let mut hint = Hint::new();
        hint.with_extension(container.extension());
        let format_options = FormatOptions {
            enable_gapless: true,
            ..Default::default()
        };
        let probed = symphonia::default::get_probe()
            .format(&hint, source, &format_options, &MetadataOptions::default())
            .map_err(|e| unreadable(&e))?;
        let format = probed.format;

        // The first track with audio in it: a video's picture track comes first.
        let track = format
            .tracks()
            .iter()
            .find(|t| {
                t.codec_params.codec != CODEC_TYPE_NULL && t.codec_params.sample_rate.is_some()
            })
            .ok_or_else(|| AudioError::Decode("This file has no audio in it.".into()))?;
        let (track_id, params) = (track.id, track.codec_params.clone());
        let sample_rate = params
            .sample_rate
            .filter(|&r| r > 0)
            .ok_or_else(|| AudioError::Decode("This recording has no sample rate.".into()))?;
        let decoder = symphonia::default::get_codecs()
            .make(&params, &DecoderOptions::default())
            .map_err(|_| {
                AudioError::Unsupported(format!(
                    "This recording's audio codec is not supported. {SUPPORTED}"
                ))
            })?;

        let max_frames = (max_seconds * f64::from(sample_rate)).floor() as u64;
        if params.n_frames.is_some_and(|n| n > max_frames) {
            return Err(too_long(max_seconds));
        }
        Ok(Self {
            format,
            decoder,
            track_id,
            sample_rate,
            channels: params.channels.map_or(0, |c| c.count()),
            frames: 0,
            max_frames,
            max_seconds,
            skip: match container {
                Container::Mp4 => mp4_priming(bytes, sample_rate),
                _ => 0,
            },
            interleaved: None,
            mono: Vec::new(),
        })
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Channels in the source, as the header reported them or the first
    /// packet revealed them.
    pub fn channels(&self) -> usize {
        self.channels
    }

    /// Mono frames decoded so far; the duration once decoding has finished.
    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// The next packet's audio, downmixed to mono; `None` at the end.
    ///
    /// A corrupt packet is skipped, as players skip it, rather than failing a
    /// long field recording over one bad frame.
    pub fn next_samples(&mut self) -> Result<Option<&[f32]>, AudioError> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(packet) => packet,
                Err(SymphoniaError::IoError(e))
                    if e.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    return Ok(None);
                }
                // A chained stream starting over with new parameters; the
                // decoder can't follow, so stop with what was read.
                Err(SymphoniaError::ResetRequired) => return Ok(None),
                Err(e) => return Err(unreadable(&e)),
            };
            if packet.track_id() != self.track_id {
                continue;
            }
            let decoded = match self.decoder.decode(&packet) {
                Ok(decoded) => decoded,
                Err(SymphoniaError::DecodeError(e)) => {
                    log::warn!("skipping an undecodable audio packet: {e}");
                    continue;
                }
                Err(e) => return Err(unreadable(&e)),
            };
            let spec = *decoded.spec();
            if spec.rate != self.sample_rate {
                return Err(AudioError::Decode(
                    "This recording changes sample rate partway through.".into(),
                ));
            }
            let channels = spec.channels.count();
            if channels == 0 || decoded.frames() == 0 {
                continue;
            }
            self.channels = channels;

            let capacity = decoded.capacity() as u64;
            if self
                .interleaved
                .as_ref()
                .is_none_or(|b| b.capacity() < decoded.capacity() * channels)
            {
                self.interleaved = Some(SampleBuffer::new(capacity, spec));
            }
            let Some(buffer) = self.interleaved.as_mut() else {
                continue;
            };
            buffer.copy_interleaved_ref(decoded);
            downmix(buffer.samples(), channels, &mut self.mono);
            if self.skip > 0 {
                let dropped = self.skip.min(self.mono.len());
                self.mono.drain(..dropped);
                self.skip -= dropped;
                if self.mono.is_empty() {
                    continue;
                }
            }

            self.frames += self.mono.len() as u64;
            if self.frames > self.max_frames {
                return Err(too_long(self.max_seconds));
            }
            return Ok(Some(&self.mono));
        }
    }
}

/// Average interleaved channels into `out`, in `f32`: sum in channel order,
/// then divide, which is NumPy's `mean(axis=1, dtype=float32)` for the
/// channel counts recordings have.
pub fn downmix(interleaved: &[f32], channels: usize, out: &mut Vec<f32>) {
    out.clear();
    if channels == 1 {
        out.extend_from_slice(interleaved);
        return;
    }
    let n = channels as f32;
    out.extend(
        interleaved
            .chunks_exact(channels)
            .map(|frame| frame.iter().fold(0.0f32, |sum, &s| sum + s) / n),
    );
}

/// Frames of encoder priming at the start of an MP4's first sound track.
///
/// AAC encoders prepend silence (1024 samples from ffmpeg, 2112 from Apple's)
/// and say so in the track's edit list. Symphonia 0.5 ignores edit lists;
/// ffmpeg, which decoded loonet's M4A audio, skips the priming, so this does
/// too. Without it every window starts 20–50 ms late. Anything unexpected
/// in the boxes means no skip, never an error.
fn mp4_priming(bytes: &[u8], sample_rate: u32) -> usize {
    let Some(moov) = child(bytes, b"moov") else {
        return 0;
    };
    for trak in boxes(moov)
        .filter(|(kind, _)| *kind == b"trak")
        .map(|(_, b)| b)
    {
        let Some(mdia) = child(trak, b"mdia") else {
            continue;
        };
        if child(mdia, b"hdlr").and_then(|h| h.get(8..12)) != Some(b"soun") {
            continue;
        }
        let timescale = child(mdia, b"mdhd")
            .and_then(|mdhd| read_u32(mdhd, if mdhd.first() == Some(&1) { 20 } else { 12 }))
            .filter(|&t| t > 0);
        let media_time = child(trak, b"edts")
            .and_then(|edts| child(edts, b"elst"))
            .and_then(first_media_time);
        return match (timescale, media_time) {
            (Some(timescale), Some(time)) => {
                let frames = time as f64 * f64::from(sample_rate) / f64::from(timescale);
                // More than a second of "priming" is not priming; leave it be.
                (frames.round() as usize).min(sample_rate as usize)
            }
            _ => 0,
        };
    }
    0
}

/// The media time the first non-empty edit starts at.
fn first_media_time(elst: &[u8]) -> Option<u64> {
    let version = *elst.first()?;
    let count = read_u32(elst, 4)? as usize;
    let (entry, time_at, wide) = if version == 1 {
        (20, 8, true)
    } else {
        (12, 4, false)
    };
    (0..count).find_map(|i| {
        let at = 8 + i * entry + time_at;
        let time = if wide {
            i64::from_be_bytes(elst.get(at..at + 8)?.try_into().ok()?)
        } else {
            i64::from(i32::from_be_bytes(elst.get(at..at + 4)?.try_into().ok()?))
        };
        // -1 marks an empty edit (a delay), not a start point.
        u64::try_from(time).ok()
    })
}

/// The payload of the first box of type `kind` directly inside `data`.
fn child<'a>(data: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    boxes(data)
        .find(|(k, _)| *k == kind)
        .map(|(_, payload)| payload)
}

/// The boxes directly inside `data`, as `(type, payload)`.
fn boxes(data: &[u8]) -> impl Iterator<Item = (&[u8; 4], &[u8])> {
    let mut rest = data;
    std::iter::from_fn(move || {
        let size = read_u32(rest, 0)? as usize;
        let kind: &[u8; 4] = rest.get(4..8)?.try_into().ok()?;
        let (header, size) = match size {
            0 => (8, rest.len()),
            1 => (
                16,
                usize::try_from(u64::from_be_bytes(rest.get(8..16)?.try_into().ok()?)).ok()?,
            ),
            n => (8, n),
        };
        let payload = rest.get(header..size)?;
        rest = &rest[size..];
        Some((kind, payload))
    })
}

fn read_u32(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(data.get(at..at + 4)?.try_into().ok()?))
}

fn too_long(max_seconds: f64) -> AudioError {
    let hours = max_seconds / 3600.0;
    AudioError::TooLong(format!(
        "This recording is longer than {hours} hours. Please split it into shorter files."
    ))
}

fn unreadable(error: &SymphoniaError) -> AudioError {
    match error {
        SymphoniaError::Unsupported(_) => AudioError::Unsupported(format!(
            "This recording's format is not supported. {SUPPORTED}"
        )),
        _ => AudioError::Decode(format!("This recording could not be read ({error}).")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A canonical 16-bit PCM WAV, interleaved.
    pub(crate) fn wav(rate: u32, channels: u16, samples: &[i16]) -> Vec<u8> {
        let data = (samples.len() * 2) as u32;
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&channels.to_le_bytes());
        out.extend_from_slice(&rate.to_le_bytes());
        out.extend_from_slice(&(rate * u32::from(channels) * 2).to_le_bytes());
        out.extend_from_slice(&(channels * 2).to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data.to_le_bytes());
        for s in samples {
            out.extend_from_slice(&s.to_le_bytes());
        }
        out
    }

    fn decode_all(bytes: &[u8], max_seconds: f64) -> Result<(u32, usize, Vec<f32>), AudioError> {
        let mut recording = Recording::open(bytes, max_seconds)?;
        let mut all = Vec::new();
        while let Some(samples) = recording.next_samples()? {
            all.extend_from_slice(samples);
        }
        assert_eq!(recording.frames(), all.len() as u64);
        Ok((recording.sample_rate(), recording.channels(), all))
    }

    #[test]
    fn sniffs_each_container_by_its_magic_bytes() {
        let cases: [(&[u8], Container); 6] = [
            (b"RIFF\0\0\0\0WAVEfmt ", Container::Wav),
            (b"fLaC\0\0\0\x22", Container::Flac),
            (b"OggS\0\x02", Container::Ogg),
            (b"\0\0\0\x20ftypM4A ", Container::Mp4),
            (b"ID3\x04\0\0", Container::Mp3),
            (&[0xFF, 0xFB, 0x90, 0x64], Container::Mp3),
        ];
        for (bytes, container) in cases {
            assert_eq!(sniff(bytes), Ok(container), "{bytes:?}");
        }
    }

    #[test]
    fn refuses_what_is_not_a_recording() {
        for bytes in [
            &b""[..],
            b"\x89PNG\r\n\x1a\n",
            b"\xFF\xD8\xFF\xE0",
            b"RIFF\0\0\0\0WEBPVP8 ",
        ] {
            assert!(
                matches!(sniff(bytes), Err(AudioError::Unsupported(_))),
                "{bytes:?}"
            );
        }
    }

    #[test]
    fn decodes_pcm_scaled_like_libsndfile() {
        let samples = [0, 16384, -32768, 32767, -1];
        let (rate, channels, mono) = decode_all(&wav(48_000, 1, &samples), 60.0).unwrap();
        assert_eq!((rate, channels), (48_000, 1));
        let expected: Vec<f32> = samples.iter().map(|&s| f32::from(s) / 32768.0).collect();
        assert_eq!(mono, expected);
    }

    #[test]
    fn averages_stereo_into_mono() {
        // Left, right, left, right.
        let (_, channels, mono) =
            decode_all(&wav(44_100, 2, &[1000, 3000, -2000, 0]), 60.0).unwrap();
        assert_eq!(channels, 2);
        assert_eq!(
            mono,
            vec![
                (1000.0 / 32768.0 + 3000.0 / 32768.0) / 2.0,
                -1000.0 / 32768.0
            ]
        );
    }

    #[test]
    fn downmix_matches_numpy_mean_for_three_channels() {
        let mut out = Vec::new();
        downmix(&[0.1, 0.2, 0.4, 1.0, -1.0, 0.5], 3, &mut out);
        assert_eq!(
            out,
            vec![(0.1f32 + 0.2 + 0.4) / 3.0, (1.0f32 - 1.0 + 0.5) / 3.0]
        );
    }

    #[test]
    fn refuses_recordings_longer_than_the_limit() {
        let one_second = vec![0i16; 8_000];
        let error = Recording::open(&wav(8_000, 1, &one_second), 0.5)
            .err()
            .unwrap();
        assert!(matches!(error, AudioError::TooLong(_)), "{error:?}");
        assert!(decode_all(&wav(8_000, 1, &one_second), 1.0).is_ok());
    }

    #[test]
    fn reads_aac_priming_from_the_mp4_edit_list() {
        let m4a = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/audio/loon_44k.m4a"),
        )
        .unwrap();
        // ffmpeg's AAC encoder primes with 1024 samples; ffprobe agrees.
        assert_eq!(mp4_priming(&m4a, 44_100), 1024);
        // Truncated or not an MP4 at all: no skip, no panic.
        assert_eq!(mp4_priming(&m4a[..m4a.len() / 2], 44_100), 0);
        assert_eq!(mp4_priming(b"\0\0\0\x08moov", 44_100), 0);
        assert_eq!(mp4_priming(b"\0\0\0\x01moov", 44_100), 0);
        assert_eq!(mp4_priming(&[], 44_100), 0);
    }

    #[test]
    fn a_truncated_or_garbled_file_is_an_error_not_a_panic() {
        let whole = wav(16_000, 1, &[5; 1600]);
        for bytes in [
            &whole[..20],
            &b"RIFF\x24\0\0\0WAVEjunkjunkjunk"[..],
            b"OggS garbage",
        ] {
            let result = decode_all(bytes, 60.0);
            assert!(
                result.is_err() || result.is_ok_and(|(_, _, m)| m.is_empty()),
                "{bytes:?}"
            );
        }
    }
}
