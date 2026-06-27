# TOEIC Local Trainer

Local TOEIC computer-based practice app for the ETS2026 resources in this workspace.

## Run

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
