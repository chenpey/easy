# Project Rules

- Use the current conversation model for semantic judgment. Do not invoke another
  model, AI CLI, or external model API without explicit user approval. This is not
  a product-specific ban. Never silently fall back to another model. Delegate only
  when the same model can be confirmed.
- Manage Python and dependencies with uv: `uv sync --locked` and `uv run --locked`.
  Use the project `.venv`, not a shared environment. Add dependencies with `uv add`;
  keep `pyproject.toml`, `uv.lock`, and `.python-version` consistent. Do not use pip,
  system Python, Node, or globally installed packages to run this project.
- Keep one EasyNews pipeline: date and keyword filtering, then semantic judgment, then
  statistics and Excel. Keywords and semantic criteria belong in `config.json`.
- Delete obsolete implementations and duplicate tools instead of archiving them.
  Keep the four runtime modules and their regression checks in `src/`; do not
  add batch-specific scripts or introduce another entry point.
- Preserve the manual reference data and deliverables. Do not overwrite existing
  Excel files. Count accepted articles separately from uncertain and pending ones.
- Verify changes with `uv run --locked src/test_easynews.py`.
