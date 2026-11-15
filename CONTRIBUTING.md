# Contributing

Bug reports and focused pull requests are welcome. For a visual or archive-data bug, include the browser, viewport size, shared view URL or sky coordinates, detector/survey, and steps to reproduce. A screenshot and About → Check connection results are useful. Do not include tokens or personal data.

Use Node.js 22.x. Before submitting JavaScript or hosting changes, run:

```bash
npm ci
npm test
npm run build
```

For image-processing changes, create a Python environment and run:

```bash
python -m pip install -r python/requirements-test.txt
cd python
python -m pytest -q
```

Keep the browser application dependency-free where practical. New archive integrations must identify their data source and preserve attribution. Do not present synthetic data as observations, or candidate detections as confirmed discoveries. Generated archive data and secrets should not be included in routine commits.

Contributions to the code are made under the repository's MIT License. Third-party assets must have documented sources and compatible terms.
