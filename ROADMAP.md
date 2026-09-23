# Roadmap

What we're working on and what comes after, in order. There are deliberately no dates: order matters more than the calendar for a volunteer project.

Ideas and votes are welcome in [issues](https://github.com/nikhil-kunapareddy/gavia/issues).

## Required features

These six capabilities define what Gavia is for. Everything else on this page supports them.

| # | Feature | Status |
| --- | --- | --- |
| 1 | Common Loon detection | ✅ Shipped |
| 2 | Common Loon counting | 🟡 Partly done |
| 3 | Acoustic Common Loon call classifier | ⚪ Not started |
| 4 | Shoreline/wetland change detection | ⚪ Not started |
| 5 | Underwater habitat structure classifier | ⚪ Not started |
| 6 | Invasive vegetation classifier | ⚪ Not started |

### 1. Common Loon detection — shipped

Find every Common Loon in a photo, with a box and a confidence score for each. The Loonet 1.0 model (`loon_v1`, YOLO11s) scores P 0.906 / R 0.879 / AP@0.5 0.891 on the `loonnet_v1` validation split. Retrained detection models can be dropped into the `models` folder in the storage location, and **Settings → Detection model** then offers a choice.

### 2. Common Loon counting — partly done

**Done:** each checked photo shows how many loons were found, both on the result and in the history list.

**Still to do:**
- **Counts across a survey.** Check a whole folder, total the loons, and export a CSV with one row per photo (file, date, count, confidences).
- **Correctable counts.** A reviewer can add a missed bird or remove a false one, and the count follows. The corrected number is what gets exported.
- **No double counting.** Overlapping photos of the same stretch of shoreline shouldn't count the same bird twice. This needs time and GPS from EXIF, at the least.

### 3. Acoustic Common Loon call classifier — not started

Open an audio recording and have Gavia find loon calls in it, labelled by call type (wail, tremolo, yodel, hoot), with timestamps and confidences.

This is Gavia's first input that isn't a photo. It needs:
- Audio decoding and a spectrogram front end.
- A classifier trained on labelled recordings.
- A timeline view for reviewing calls.
- Long field recordings processed in chunks, so an overnight file doesn't have to fit in memory.

### 4. Shoreline/wetland change detection — not started

Compare two images of the same shoreline or wetland taken at different times, and highlight what changed: erosion, flooding, lost or new vegetation, new structures.

It needs:
- **Paired imagery.** Before-and-after photos, or aerial and drone images of one site.
- **Alignment** of the two images, so the comparison isn't just camera movement.
- **A change or segmentation model,** plus a side-by-side or overlay view.
- **Areas reported in real units** where the imagery allows it.

### 5. Underwater habitat structure classifier — not started

Classify underwater photos by habitat structure, such as substrate type, submerged vegetation and woody debris, to describe the foraging and nesting-lake habitat loons depend on.

It needs:
- A labelled underwater image set.
- A classification (or segmentation) model.
- Handling for turbid, low-light and colour-shifted underwater imagery.

### 6. Invasive vegetation classifier — not started

Identify invasive aquatic and shoreline plants in photos, such as Eurasian watermilfoil and purple loosestrife, so their spread can be tracked alongside loon habitat.

It needs:
- A labelled set of the target species and the native plants they're confused with.
- A classifier.
- Results that can be exported with location and date for mapping.

### What the app needs before features 3–6

Today the model system understands exactly one kind of model: a detector that outputs boxes. Before any of 3–6 can land, Gavia needs:

- **Model kinds.** A model's `.json` says whether it's a detector, a classifier, a change model or an audio model. The core picks the right pre- and post-processing for it, and Settings groups models by kind.
- **A screen per task.** "Check a photo" stays as it is. Each new feature gets its own entry point instead of being folded into it.
- **One history for all results.** Photos, recordings and image pairs are all saved checks, with the same keep-or-discard review.
- **Evaluation for every kind.** Each feature gets its own `evaluate` example with published numbers before it ships, the same bar detection had to clear.

## Now

- **First public release** on all three systems.
- **Testing on real Windows and Linux machines.** Reports from people who use them every day are the most useful thing right now.
- **Survey counting** (feature 2): batch checking and CSV export.

## Next

- **Model kinds** in the core and in Settings, the groundwork for features 3–6.
- **Signed installers.** Apple Developer ID signing and notarisation for macOS, and code signing on Windows, so installing takes no extra steps.
- **Keyboard review.** Accept, reject and move to the next photo without the mouse.
- **Intel Mac builds,** if there's demand. ONNX Runtime doesn't publish them, so this means building it ourselves.

## Later

- **Correcting boxes.** Move, resize, add or delete a box while reviewing, and save the corrected version. Corrections feed correctable counts (feature 2), and they're exactly the labelled data a better model needs.
- **Export for retraining.** Saved and corrected checks exported as a YOLO dataset.
- **GPS and date from EXIF,** shown with each check and included in exports. Needed for survey counts and for mapping invasive vegetation.

## Just shipped

- **One app for macOS, Windows and Linux.** The Python backend was rewritten in Rust inside the app itself. The download went from 84 MB to 43 MB, with no background server, and the accuracy is the same (AP@0.5 0.892 before, 0.891 after).
- **Installers built by CI** for every change and every release.
- **Settings:** light, dark and system themes, a movable storage location (on macOS, now `~/Library/Gavia`), and a choice of detection model once more than one is installed.
- **Help** behind the **?** button in the header.

## Not planned

- **Cloud processing or accounts.** Gavia stays offline and on your computer.
- **Telemetry.** Gavia will not collect anything about how it's used.
