# Plant fixtures

Photos for `tests/plants.rs`, one per invasive species vegnet finds in them.
What the model should report for each is in `../vegnet_reference.json`,
written by `scripts/vegnet_reference.py`; regenerate it if a photo changes.

| File | Species | Made from |
|---|---|---|
| `loosestrife.jpg` | purple loosestrife (*Lythrum salicaria*) | iNaturalist photo 539269086, [observation 299323753](https://www.inaturalist.org/observations/299323753), CC0 |
| `water_chestnut.jpg` | water chestnut (*Trapa natans*) | iNaturalist photo 45364993, [observation 29077338](https://www.inaturalist.org/observations/29077338), CC0 |
| `yellow_iris.jpg` | yellow flag iris (*Iris pseudacorus*) | iNaturalist photo 199840188, [observation 118291029](https://www.inaturalist.org/observations/118291029), CC0 |

Each is the vegnet_v1 val photo of that name, shrunk to 800 px on its long side
with Pillow (Lanczos, JPEG quality 85). All three are CC0 (no rights
reserved), via loonet's `data/vegnet_raw/manifest.csv`. None of the val photos
of common reed is CC0, so that species has no fixture.
