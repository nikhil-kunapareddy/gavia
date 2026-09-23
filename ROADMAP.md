# Roadmap

What we're working on and what comes after, in order. There are deliberately no dates: order matters more than the calendar for a volunteer project.

Ideas and votes are welcome in [issues](https://github.com/nikhil-kunapareddy/gavia/issues).

## Just shipped

- **One app for macOS, Windows and Linux.** The Python backend was rewritten in Rust inside the app itself. The download went from 84 MB to 43 MB, with no background server, and the accuracy is the same (AP@0.5 0.892 before, 0.891 after).
- **Installers built by CI** for every change and every release.

## Now

- **First public release** on all three systems.
- **Testing on real Windows and Linux machines.** Reports from people who use them every day are the most useful thing right now.

## Next

- **Signed installers.** Apple Developer ID signing and notarisation for macOS, and code signing on Windows, so installing takes no extra steps.
- **Intel Mac builds,** if there's demand. ONNX Runtime doesn't publish them, so this means building it ourselves.
- **Batch checking.** Point Gavia at a folder, check every photo, review the results as a list, and export a CSV of counts per photo.
- **Keyboard review.** Accept, reject and move to the next photo without the mouse.

## Later

- **Correcting boxes.** Move, resize, add or delete a box while reviewing, and save the corrected version. Corrections are also exactly the labelled data a better model needs.
- **Export for retraining.** Saved and corrected checks exported as a YOLO dataset.
- **More species and life stages,** such as chicks and other loon species, as labelled data allows.
- **GPS and date from EXIF,** shown with each check and included in exports.

## Not planned

- **Cloud processing or accounts.** Gavia stays offline and on your computer.
- **Telemetry.** Gavia will not collect anything about how it's used.
