# TOEIC Local Trainer

Local TOEIC computer-based practice app for the ETS2026 resources in this workspace.

## Run

Download large local assets first:

```sh
npm run assets:download
```

Then start the app:

```sh
npm run dev
```

Open `http://localhost:4173` by default. To choose another port:

```sh
PORT=4175 npm run dev
```

## Data

- Audio/PDF source: `resources/ETS2026`
- Attempts are saved to `data/attempts.json`
- Answer keys are saved to `data/answer-keys.json`
- Rendered PDF page images are cached under `data/pdf-pages`

Data files and cache folders are created automatically after you submit a test, save an answer key, or open source pages in the exam UI.

## Large Assets From Google Drive

GitHub is not a good place for the large PDF/audio files under `resources/`. This repo uses `asset-manifest.json` plus `scripts/download-assets.mjs` so a fresh clone can download those files from a public Google Drive share.

Recommended setup:

1. Create the upload zip:

```sh
npm run assets:zip
```

This writes `.asset-cache/toeic-assets.zip`. The `.asset-cache/` folder is ignored by Git.

2. Upload `.asset-cache/toeic-assets.zip` to Google Drive.
3. Set sharing to "Anyone with the link can view".
4. Paste the public share URL into `asset-manifest.json`.
5. Users run:

```sh
npm run assets:download
```

The default manifest expects one zip bundle:

```json
{
  "assets": [
    {
      "type": "zip",
      "extractTo": ".",
      "filename": "toeic-assets.zip",
      "url": "https://drive.google.com/file/d/FILE_ID/view?usp=sharing"
    }
  ]
}
```

You can also list individual files:

```json
{
  "assets": [
    {
      "path": "resources/ETS2026/READING ETS 2026 .pdf",
      "url": "https://drive.google.com/file/d/FILE_ID/view?usp=sharing"
    }
  ]
}
```

The script also accepts raw Google Drive file IDs via `googleDriveId`.

The zip script currently packages these ignored PDF assets:

- `resources/ETS2026/READING ETS 2026 .pdf`
- `resources/ETS2026/LISTENING ETS 2026 .pdf`
- `resources/ETS2026/Transcript.pdf`
- the two vocabulary PDF files in `resources/ETS2026/Vocab/Vocab/`

## Flow

The app includes a pre-test flow before the timer starts:

1. Candidate/test confirmation
2. Sound check using the selected ETS audio
3. Directions, then `Begin test`

After submitting an attempt, open `Review attempt` to filter `Wrong`, `Unanswered`, `Marked`, or a specific Part. Use `Start drill` to create a focused practice session from the currently filtered questions.

## Exam Controls

- Change `Listening delay between items (seconds)` on the home screen before starting a test. The value is saved locally in the browser and used after each Listening audio file ends.
- Use the `Page` buttons in the left PDF preview to move the rendered source page backward or forward when the automatic page estimate is offset.

## Answer Key Formats

Open an attempt, click `Answer key`, then paste one of these formats:

```json
{"1":"A","2":"C","101":"B"}
```

```text
1:A 2:C 101:B
```

A 200-letter string maps to questions 1-200. A 100-letter string maps to questions 101-200 for Reading practice.
