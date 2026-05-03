# Project Conventions

- Keep persistent AI context under `.athva/contexts/` only.
- Keep `.athva/contexts/context.md` as a pure `name -> path` index.
- Keep `.athva/contexts/task-history.md` as a pure `task title -> task file path` index.
- Store full task details in `.athva/contexts/history/*.md`.
- Prefer targeted context loading over broad project reads.
