# Getting MMM-KiaAccess into the 3rd-party module list

MagicMirror's module directory (<https://modules.magicmirror.builders>) is
generated from the **MagicMirror wiki** page
["3rd-Party-Modules"](https://github.com/MagicMirrorOrg/MagicMirror/wiki/3rd-Party-Modules).

To list this module, add one row to the **Vehicle** (or **Utility**) table on
that wiki page — it is publicly editable with a GitHub account:

```
| **[MMM-KiaAccess](https://github.com/Legal-Copy7045/MMM-KiaAccess)** <br> by Legal-Copy7045 | Kia Connect / Bluelink vehicle data (built for the Kia EV9): configurable table, an animated top-down car diagram, edge-triggered state-change notifications, and optional MQTT / Home Assistant publishing. |
```

Then it appears on modules.magicmirror.builders within a day (the site rebuilds
from the wiki on a schedule).

The repo already carries the `magicmirror` / `magicmirror-module` GitHub topics
so it also turns up in a topic search in the meantime.
