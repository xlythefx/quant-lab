---
tags: [validation]
type: tool
---

# Grid Search

`pages/GridSearch.jsx` + a backend job runner (`services/grid_search.py`) that streams `gs_progress` over the socket. Sweeps numeric param ranges and shows the performance surface — useful for seeing **plateau vs spike** (robust region vs lucky peak → [[Validation and Overfitting]]).

Caveat: optimizes *numeric* params; non-numeric ones (e.g. `regime_method` select, `allowed_*` checkboxes) aren't swept here.

Related: [[Walk-Forward]] · [[Monte Carlo]] · [[Cost Sweep]]
