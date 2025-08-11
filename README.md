**WebMCFont** is a WebGL2-based pixel font renderer designed for retro-style UIs, games, and chat systems.  
It provides precise control over glyph spacing, baseline alignment, and mixed rendering between ASCII and non-ASCII characters (e.g., Hangul), ensuring crisp and consistent typography.

---

## ✨ Features
- **Pixel-perfect rendering** using WebGL2 (no anti-aliasing blur)
- **Mixed-mode rendering**: seamlessly combine ASCII (`default8`) and Unicode glyph tiles (`glyph_xx`)
- **Per-glyph spacing adjustments** for better visual balance
- **Automatic quote flipping** for proper opening/closing quotation marks
- **Glyph atlas preprocessing**:
  - Comma (`,`) shape alignment fix
  - Left-margin normalization for ASCII glyphs in `glyph_00.png`
- **Baseline locking** to prevent vertical "jump" when switching between ASCII and glyph characters
- **Custom spacing options**:
  - Extra tracking between consecutive glyphs
  - Adjustable padding for ASCII after glyphs
  - Space width multiplier

---

## Usage
Include the script in your project:
```html
<script type="module">
  import { MCFontRenderer } from './MCFont.js';
</script>
```

```javascript
const canvas = document.getElementById('myCanvas');
const renderer = new MCFontRenderer({ canvas, basePath: './images/font' });

await renderer.init();
renderer.draw('Hello, my name is 0isback!', {
  color: '#ffffff',
  scale: 2,
  mode: 'mixed',
  glyphTrackPx: 2,
  asciiAfterGlyphPadPx: 2.5
});
```
