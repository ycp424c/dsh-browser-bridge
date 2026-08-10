# dsh-browser-bridge

Prompt-scoped bridge between DSH and explicitly attached Chrome tabs.

The first product scenario is a development loop in which DSH changes code,
observes the real page already open in the user's browser, verifies the result,
and continues editing. The bridge itself remains general-purpose and can also
support debugging, issue reproduction, information extraction, form operations,
and lightweight browser automation.

The approved design is documented in
[`docs/superpowers/specs/2026-08-10-dsh-browser-bridge-design.md`](docs/superpowers/specs/2026-08-10-dsh-browser-bridge-design.md).
