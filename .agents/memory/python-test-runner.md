---
name: Python test runner environment
description: Workspace-specific note about running backend pytest with the installed Python packages.
---

When the `pytest` launcher reports `_pytest` missing, check the interpreter and installed package path before reinstalling dependencies. In this workspace, packages were present under `.pythonlibs/lib/python3.12/site-packages`, while the default launcher did not include that directory; running `python -m pytest` with that path in `PYTHONPATH` worked.

**Why:** the Python runtime and the workspace package path can be out of sync, producing a misleading missing-package error even though pytest is installed.

**How to apply:** inspect `python --version`, the pytest launcher, and `.pythonlibs/lib/` first; use the matching interpreter and package path for verification.
