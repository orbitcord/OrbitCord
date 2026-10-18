# Account switcher hover collapse

Discord's profile Switch Accounts submenu inherits a layer-generated
`--reference-position-layer-max-height` based on space below the trigger.
In the live Electron renderer this capped a 189px account list at 119px,
making it shrink into a scroller after mounting.

The account submenu alone now uses the viewport height minus Discord's menu
padding as its maximum height. Discord's existing placement logic then moves
the menu upward: the live list settled at 189px with no scroll overflow and
its bottom inside the viewport. No account actions or hover handlers change.
Short windows still scroll, and other menus retain their original cap.

Verification: live Electron reproduction and CSS probe; Chromium regression
fixture covers the inherited 119px constraint, unrelated menus, and scrolling
in a 200px viewport.

Risks: Discord can change its submenu ID or placement behavior in a future
update; the selector intentionally applies only to the current account menu.

## Message More menu

The message toolbar's More popup (`#message-actions`) has the same inherited
layer cap. Live Electron inspection found a 530px cap on roughly 596px of
content. Applying the viewport-based cap moved its top from 724px to 658px,
with the bottom inside the 1266px viewport and no scroller overflow.
The fix also covers the message context menu (`#message[role="menu"]`).
Regression fixtures cover both message menu IDs, unrelated menu isolation,
and scrolling when the window is genuinely too short.
