# Audio fixtures

Short clips for `tests/calls.rs`, one per container the call model reads. The
expected P(loon) for each window is in `../looncall_reference.json`, written by
`scripts/looncall_reference.py`; regenerate it if a clip changes.

| File | Made from | How |
|---|---|---|
| `loon.mp3` | iNaturalist sound 1192373, Common Loon, [observation 239589873](https://www.inaturalist.org/observations/239589873), CC0 | first 6.6 s, stream copy (48 kHz mono) |
| `loon_44k_stereo.ogg` | `loon.mp3` | Vorbis, 44.1 kHz, right channel at half volume |
| `loon_16k.flac` | `loon.mp3` | first 3.4 s, 16 kHz mono |
| `loon_44k.m4a` | `loon.mp3` | AAC 64 kbps, 44.1 kHz mono (ffmpeg primes 1024 samples) |
| `bullfrog.mp3` | iNaturalist sound 2060360, American Bullfrog, [observation 378939741](https://www.inaturalist.org/observations/378939741), CC0 | first 4 s, stream copy |

Both source recordings are CC0 (no rights reserved), via loonet's
`data/looncall_raw/manifest.csv`.
