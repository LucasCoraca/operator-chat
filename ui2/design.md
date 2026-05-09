# Studio Console — Design System

A quiet, editorial dark interface for an AI agent console. The name of the
direction is **Studio Console**: tools‑heavy software, but presented with the
restraint of an editorial product. The screen should feel less like an IDE and
more like a workbench you actually want to spend the day in.

---

## 1. Principles

1. **Hairlines, not boxes.** Every container is separated by a 1px translucent
   line, never a hard slab of fill. Surfaces are layered in `rgba(white, n)`
   over a single warm‑graphite base — depth comes from light, not from boxes.
2. **One accent. Used sparingly.** Pistachio green carries _state_ (active,
   success, primary action) and nothing else. It never decorates.
3. **Type does the work.** Headlines mix sans + a serif italic accent so a
   running task feels like a chapter title, not a row in a table. Numbers and
   paths are always monospace.
4. **Calm motion.** Pulses, shimmers and fade‑ups stay under 200ms and
   under 0.6 alpha. Nothing bounces.
5. **Density on demand.** Comfortable by default, compact for power users, with
   a single Tweak that swaps spacing scales.

---

## 2. Color

All colors are defined as CSS custom properties on `:root`. Surfaces are warm
graphite; accents and status colors are authored in **OKLCH** so they share a
common lightness/chroma feel.

### Surfaces

| Token         | Value      | Use                               |
| ------------- | ---------- | --------------------------------- |
| `--bg-0`      | `#0c0d0f`  | Page base                         |
| `--bg-1`      | `#121316`  | Sidebar, overlay panels           |
| `--bg-2`      | `#181a1e`  | Hover fills (rare)                |
| `--bg-3`      | `#22252b`  | Pressed states                    |
| `--bg-elev`   | `#1c1f24`  | Tooltips, popovers                |

The body has two soft radial gradients washed over `--bg-0`: a 6% pistachio
glow at top‑right and a 4% blue at bottom‑left. They should be barely visible.

### Foreground

| Token   | Value     | Use                                  |
| ------- | --------- | ------------------------------------ |
| `--fg-0`| `#ecedef` | Primary text, headings               |
| `--fg-1`| `#b8bbc1` | Body, secondary headings             |
| `--fg-2`| `#7e828a` | Labels, captions                     |
| `--fg-3`| `#4f535b` | Disabled, separators, mono meta      |

### Hairlines

Borders are translucent white, never opaque grey. This keeps the warmth of the
underlying surface visible.

| Token       | Value                | Use                          |
| ----------- | -------------------- | ---------------------------- |
| `--line`    | `rgba(255,255,255,.055)` | Default 1px hairline    |
| `--line-2`  | `rgba(255,255,255,.10)`  | Hover, focused inputs   |
| `--line-3`  | `rgba(255,255,255,.16)`  | Strong dividers         |

### Accent — Pistachio

```css
--accent:       oklch(0.82 0.16 145);
--accent-ink:   #0a1410;          /* text on accent */
--accent-soft:  color-mix(in oklch, var(--accent) 14%, transparent);
--accent-line:  color-mix(in oklch, var(--accent) 28%, transparent);
--accent-glow:  color-mix(in oklch, var(--accent) 38%, transparent);
```

Pistachio is reserved for **active task indicator**, **primary CTA**, **success
state**, and the brand mark. Never decorative.

### Status

Status colors all sit at `oklch(0.74–0.82 0.13)` so they read at the same
visual weight as the accent.

| Token       | OKLCH                  | Use                  |
| ----------- | ---------------------- | -------------------- |
| `--amber`   | `oklch(0.82 0.13 78)`  | Running, working, in‑progress |
| `--rose`    | `oklch(0.74 0.13 18)`  | Errors, destructive  |
| `--blue`    | `oklch(0.74 0.13 245)` | Remote env, info     |
| `--violet`  | `oklch(0.75 0.13 290)` | Reasoning, JSON      |

Each has a `-soft` (12% mix) and `-line` (24% mix) companion.

---

## 3. Typography

Three families, layered intentionally.

| Stack         | Family                 | Use                                   |
| ------------- | ---------------------- | ------------------------------------- |
| `--font-sans` | **Geist**              | UI, body, headings                    |
| `--font-serif`| **Instrument Serif** _italic_ | Editorial accent inside headlines, "—" interjections |
| `--font-mono` | **Geist Mono**         | Paths, tokens/sec, file glyphs, terminal output |

### Scale

| Role                  | Size  | Weight | Tracking |
| --------------------- | ----- | ------ | -------- |
| Hero / task title     | 30px  | 500    | -0.022em |
| Section title         | 18px  | 600    | -0.014em |
| Body                  | 13.5px| 400    | -0.005em |
| UI default            | 13px  | 400    | -0.005em |
| Caption / meta        | 12px  | 400    | 0        |
| Eyebrow / tag (mono)  | 10px  | 600    | 0.08em uppercase |
| Stat value            | 16px  | 500    | -0.018em tabular |

### Editorial italic

The signature move: a noun inside a headline runs in **Instrument Serif italic**.
It signals the _subject_ of the run.

> Set up *logistics‑app* dev environment

Use it ONCE per heading, on the proper noun or verb that carries the meaning.

---

## 4. Geometry

| Token            | Value     | Use                                |
| ---------------- | --------- | ---------------------------------- |
| `--radius`       | `12px`    | Cards, composer, primary surfaces  |
| `--radius-sm`    | `8px`     | Buttons, inputs                    |
| `--radius-pill`  | `999px`   | Tags, status pills                 |

Radius scales with surface size: small chips at 6, controls at 8, panels at 12,
bottom sheets at 14.

### Spacing

A 4px base. Common rhythm: `4 · 6 · 8 · 10 · 12 · 16 · 20 · 28`.
Avoid 14, 18, 22 unless aligning to a sibling already using them.

---

## 5. Elevation

Three steps. Most of the UI uses `none` or `--shadow-1`.

```css
--shadow-1: 0 1px 0 rgba(255,255,255,.04) inset, 0 1px 2px rgba(0,0,0,.35);
--shadow-2: 0 1px 0 rgba(255,255,255,.04) inset,
            0 8px 24px -10px rgba(0,0,0,.6),
            0 2px 6px -2px rgba(0,0,0,.4);
--ring:     0 0 0 1px var(--line-2),
            0 0 0 4px color-mix(in oklch, var(--accent) 15%, transparent);
```

`--shadow-2` is the composer. `--ring` is focus.

The "inset top highlight" — `0 1px 0 rgba(255,255,255,.04) inset` — appears on
nearly every layered card. It's what makes them look milled instead of flat.

---

## 6. Components

### Buttons

| Class           | Look                          | Use                            |
| --------------- | ----------------------------- | ------------------------------ |
| `.send-btn`     | Solid pistachio, dark ink text | Primary action (one per view)  |
| `.action-btn`   | Ghost, hover fills            | Composer toolbar               |
| `.rail-action`  | Subtle elevated chip          | Rail run controls              |
| `.icon-btn`     | 28×28, transparent            | Header & toolbar icons         |
| `.rail-btn`     | 38×38, transparent            | Collapsed sidebar              |
| `.quick-action` | Full‑width row + kbd hint     | Sidebar nav                    |

Primary buttons have an accent‑glow ring on hover (`box‑shadow: 0 0 0 4px
var(--accent-soft)`). They never animate scale.

### Pills & tags

- **Status pill** — translucent fill + matching border + matching‑color dot.
  Always pulse the dot at `1.6s ease‑out infinite`.
- **Task pill** — accent‑soft fill, accent border, mono uppercase letter‑spacing
  `0.08em`. Used for category labels and taxonomy.

### Inputs

`.search-input` and `.composer textarea` share the pattern: translucent fill on
a hairline, focus brings up a 3–4px diffuse ring made from white, not accent.
The accent is reserved.

### Cards

```css
background: linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.005));
border: 1px solid var(--line);
border-radius: 12px;
box-shadow: inset 0 1px 0 rgba(255,255,255,.03);
```

The vertical gradient + inset highlight is the signature of a Studio Console
card. Use it for rail panels, terminal blocks, run status, telemetry.

### Segmented controls

`.seg`, `.env-tabs` — 3px outer padding, 6px inner radius. Active segment uses
a vertical white gradient + inset highlight (no accent fill).

### Terminal block

Mono, hairline border, 10px radius, vertical gradient surface. The leading `$`
is `--accent`. Logs use semantic colors (`#7fd6a8` for ok, `oklch` rose for
errors). A blinking amber bar marks `running…`.

---

## 7. Layout

Three columns on desktop, all flexbox/grid + `gap`. Never inline‑flow rows.

| Column     | Width  | Background        | Notes                        |
| ---------- | ------ | ----------------- | ---------------------------- |
| Sidebar    | 272px  | `--bg-1`          | Brand · quick · search · list · footer |
| Files      | 340px  | `--bg-0`          | Optional, slides in          |
| Thread     | flex   | transparent       | Max content width 820px      |
| Rail       | 272px  | transparent       | Stacked cards                |

**Header** is 52px, hairline‑bottomed, with a backdrop blur of 10px and a 2%
top‑highlight gradient. The breadcrumb uses `--fg-3` for the parent and
`--fg-0` for the current task.

**Thread** scrolls in a centered 820px column with 28px side padding (20 on
tablet, 14 on mobile). Each turn is separated by a hairline, not a box.

**Composer** floats inside a 14px‑radius layered card with a focus ring. It is
the only element that uses `--shadow-2`.

---

## 8. Motion

Single, shared animation grammar.

| Keyframe   | Duration | Curve            | Use                      |
| ---------- | -------- | ---------------- | ------------------------ |
| `pulse-dot`| 1.6s     | ease‑out infinite| Status / running dots    |
| `blink`    | 1.0s     | step‑end infinite| Terminal cursor          |
| `shimmer`  | 2.0s     | linear infinite  | Progress bar gloss       |
| `fade-up`  | 0.30s    | ease             | Newly inserted rows      |
| `slide‑in` | 0.22s    | ease             | Side overlays            |
| Hover      | 0.15s    | ease             | All buttons, all states  |

Never animate transform.scale on buttons. Never use bouncy or elastic curves.

---

## 9. Iconography

16px stroke icons, `1.5px` stroke, `currentColor`, rounded line caps. Inlined
SVG in `icons.jsx`. No icon‑first; always paired with a label unless the
control is a 28px `.icon-btn` with a `title` attribute.

---

## 10. Editorial details

These are the small choices that set the tone:

- The agent's brand mark sits in a layered accent‑soft tile with an
  `accent‑glow` shadow — it's the only place pistachio is allowed to "ring".
- The footer avatar is a duo‑tone OKLCH gradient (warm cool indigo), not a
  flat fill.
- "Working — patching `scripts/dev.sh`" uses an em‑dash + serif italic
  conjunction, not an ellipsis.
- Token counters always use `font-feature-settings: "tnum"` so digits don't
  shimmy when the number changes.
- Eyebrow labels (rail card titles, footer caption) are mono uppercase at
  `0.08em` tracking. Never sans‑uppercase — that's a tropes red flag.

---

## 11. Don't

- Don't introduce a second accent. The system has one.
- Don't use accent for hover backgrounds. White at 3–6% alpha.
- Don't use solid grey borders. Always translucent white.
- Don't add icons for decoration. Icons earn their place.
- Don't use Inter, Roboto, or system‑ui — Geist is the voice.
- Don't render glyphs in pure black on accent fills. Use `--accent-ink`.
- Don't tile drop shadows. Most cards take none.
