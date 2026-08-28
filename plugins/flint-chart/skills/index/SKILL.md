---
name: index
description: Route chart requests to the bounded Flint chart authoring workflow.
---

# Routing

For chart requests, use `$author`.

Flint is a declarative chart intermediate language. This plugin authors the
portable input; the host owns compilation and rendering. Do not emit HTML,
JavaScript, React, Vega runtime code, remote data URLs, or executable scripts.
