// MCFont.js (final, cleaned)
// FontPE → WebGL
// - Ordered & batched draw
// - Baseline lock/jump prevention
// - Mixed-mode smart spaces
// - Glyph tracking (한글 자간 보정)
// - Always-tweaked ASCII comma
// - Open/close quotes (ASCII) alternate tiles
// - glyph_00: left margin normalize (ASCII 32~126)
//
// draw() options:
//   - color       : '#rrggbb' (default '#ffffff')
//   - align       : 'left' | 'center' | 'right' (default 'left')
//   - scale       : number (default 2)
//   - shadow      : boolean (default true)
//   - ds          : ASCII(default8) scale only (default 1.5)
//   - spaceMul    : space width mul (default 0.5)
//   - spacingMul  : advance mul (default 1.0)
//   - mode        : 'auto' | 'mixed' | 'default' | 'glyph' (default 'auto')
//   - baseline    : 'ascii' | 'glyph' | 'auto' (default 'ascii')
//   - lockLineH   : boolean, if true lineH=16px*scale (default true)
//   - glyphTrackPx: extra tracking between consecutive glyphs (default 2)
//   - asciiAfterGlyphPadPx: in mixed mode, padding before ASCII that follows glyph (default 2.5)

export class MCFontRenderer {
    constructor({
        canvas,
        basePath = './images/font'
    } = {}) {
        this.canvas = canvas;
        this.basePath = basePath.replace(/\/$/, '');

        this.gl = null;
        this.program = null;
        this.loc = {};
        this.vbo = null;
        this.vao = null;

        // Device pixel ratio(최대 2로 클램프: 픽셀 폰트 보존)
        this.DPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));

        // Texture packs
        // pack: { tex, w, h, scan:{alpha,width,height}, adv[256], vmet:{centerRow,tileH} }
        this.ascii = null; // default8.png (8x8)
        this.glyphs = new Map(); // glyph_XX.png (16x16), key = "00".."FF"

        // 여는 따옴표 전용 대체 타일(8x8 단일 텍스처 pack)
        // quoteAlt[34] → " / quoteAlt[39] → '
        this.quoteAlt = {};
    }

    // ------------------------- Init -------------------------
    async init() {
        const gl = this.canvas.getContext('webgl2', {
            alpha: false,
            antialias: false,
            preserveDrawingBuffer: true
        });
        if (!gl)
            throw new Error('WebGL2 required');
        this.gl = gl;

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        // Minimal shader (alpha mask → uniform color)
        const vs = `#version 300 es
precision mediump float;
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aUV;
uniform vec2 uRes;
out vec2 vUV;
void main(){
  vec2 p = aPos / uRes * 2.0 - 1.0;
  p.y = -p.y;
  gl_Position = vec4(p, 0.0, 1.0);
  vUV = aUV;
}`;
        const fs = `#version 300 es
precision mediump float;
uniform sampler2D uTex;
uniform vec4 uColor;
in vec2 vUV;
out vec4 outColor;
void main(){
  float a = texture(uTex, vUV).a;
  outColor = vec4(uColor.rgb, a * uColor.a);
}`;

        this.program = this._makeProgram(vs, fs);
        this.loc.uRes = gl.getUniformLocation(this.program, 'uRes');
        this.loc.uColor = gl.getUniformLocation(this.program, 'uColor');
        this.loc.uTex = gl.getUniformLocation(this.program, 'uTex');

        this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);

        this.vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);

        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);

        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);

        // Load default8.png
        this.ascii = await this._loadAtlas(`${this.basePath}/default8.png`, 8, 8, true);

        // Auto-resize
        new ResizeObserver(() => this._resize()).observe(this.canvas);
        this._resize();
    }

    // ------------------------- Draw -------------------------
    async draw(text, opts = {}) {
        const {
            color = '#ffffff',
            align = 'left',
            scale = 2,
            shadow = true,

            ds = 1.5,
            spaceMul = 0.5,
            spacingMul = 1.0,

            mode = 'auto',
            baseline = 'ascii',
            lockLineH = true,

            glyphTrackPx = 2,
            asciiAfterGlyphPadPx = 2.5
        } = opts;

        if (!this.ascii)
            return;

        // Helpers
        const gl = this.gl;
        const dp = (n) => Math.round(n * scale);
        const rgb = this._hexToRgb(color);
        const grid = 16;
        const isAsciiCode = (cp) => cp <= 0x7F;
        const codeHi = (cp) => ((cp >>> 8) & 0xFF).toString(16).padStart(2, '0').toUpperCase();
        const codeLo = (cp) => (cp & 0xFF);

        this._resize();

        // Mode → defaultOnly: true(only-ascii), false(only-glyph), null(mixed)
        let defaultOnly;
        if (mode === 'default')
            defaultOnly = true;
        else if (mode === 'glyph')
            defaultOnly = false;
        else if (mode === 'mixed')
            defaultOnly = null;
        else {
            // auto
            defaultOnly = [...text].every(ch => isAsciiCode(ch.codePointAt(0)));
        }

        // Preload glyph pages
        const need = new Set();
        if (defaultOnly === false || mode === 'glyph')
            need.add('00'); // ASCII glyph page
        if (defaultOnly === false || mode === 'glyph') {
            for (const ch of text)
                need.add(codeHi(ch.codePointAt(0)));
        } else if (defaultOnly === null) {
            for (const ch of text) {
                const cp = ch.codePointAt(0);
                if (!isAsciiCode(cp))
                    need.add(codeHi(cp));
            }
        }
        await this._ensureGlyphPacks(need);

        const asciiPack = this.ascii;
        const glyph00 = this.glyphs.get('00');

        // hasGlyph: 조합 안에 glyph가 하나라도?
        const hasGlyph =
            mode === 'glyph' ||
            (mode === 'mixed' && [...text].some(ch => !isAsciiCode(ch.codePointAt(0)))) ||
            (mode === 'auto' && !defaultOnly);

        // line height & baseline center(Y) 결정
        const lineH = lockLineH ? dp(16)
             : (defaultOnly ? dp(Math.max(8 * ds, 16)) : dp(16));

        let refCenter; // 타일-좌표계에서의 세로 중심(픽셀)
        if (baseline === 'ascii') {
            // glyph가 섞이면 ascii center × 2.0으로 고정 → 전환 점프 방지
            refCenter = asciiPack.vmet.centerRow * (hasGlyph ? 2.0 : ds);
        } else if (baseline === 'glyph') {
            refCenter = (glyph00 ? glyph00.vmet.centerRow : asciiPack.vmet.centerRow * 2.0);
        } else { // auto
            refCenter = hasGlyph
                 ? (glyph00 ? glyph00.vmet.centerRow : asciiPack.vmet.centerRow * 2.0)
                 : (asciiPack.vmet.centerRow * ds);
        }

        // Generate spans (ordered)
        const spans = [];
        let penX = 0;
        let prevKind = null; // 'ascii' | 'glyph' | null
        let dqCount = 0; // " 카운터
        let sqCount = 0; // ' 카운터

        const pushQuad = (pack, x, y, w, h, u0, v0, u1, v1) => {
            spans.push({
                pack,
                x,
                y,
                w,
                h,
                u0,
                v0,
                u1,
                v1
            });
        };

        const pushAscii = (code) => {
            // mixed: glyph 뒤에 바로 ASCII 오면 살짝 여백
            if (defaultOnly === null && prevKind === 'glyph' && asciiAfterGlyphPadPx > 0) {
                penX += Math.round(scale * asciiAfterGlyphPadPx);
            }

            // 기본(default8) 타일 UV
            let pack = asciiPack;
            const cx = code % grid,
            cy = (code / grid) | 0;
            let u0 = (cx * 8) / pack.w,
            v0 = (cy * 8) / pack.h;
            let u1 = ((cx + 1) * 8) / pack.w,
            v1 = ((cy + 1) * 8) / pack.h;

            // 여는 따옴표 교체(홀수번째 등장 시)
            if (defaultOnly !== false) {
                if (code === 34) { // "
                    if (++dqCount % 2 === 1 && this.quoteAlt[34]) {
                        pack = this.quoteAlt[34];
                        u0 = v0 = 0;
                        u1 = v1 = 1;
                    }
                } else if (code === 39) { // '
                    if (++sqCount % 2 === 1 && this.quoteAlt[39]) {
                        pack = this.quoteAlt[39];
                        u0 = v0 = 0;
                        u1 = v1 = 1;
                    }
                }
            }

            const myCenter = asciiPack.vmet.centerRow * ds; // vmet 기준은 ascii
            const yShift = Math.round(dp(refCenter - myCenter));
            pushQuad(pack, penX, yShift, dp(8 * ds), dp(8 * ds), u0, v0, u1, v1);

            penX += Math.round(dp((asciiPack.adv[code] ?? 9) * ds) * spacingMul);
            prevKind = 'ascii';
        };

        const pushGlyph = (code) => {
            // glyph 연속 자간 보정
            if (glyphTrackPx > 0 && prevKind === 'glyph')
                penX += Math.round(scale * glyphTrackPx);

            const hi = codeHi(code);
            const pack = this.glyphs.get(hi) || glyph00 || asciiPack;
            const lo = codeLo(code);
            const cx = lo % grid,
            cy = (lo / grid) | 0;
            const u0 = (cx * 16) / pack.w,
            v0 = (cy * 16) / pack.h;
            const u1 = ((cx + 1) * 16) / pack.w,
            v1 = ((cy + 1) * 16) / pack.h;

            const myCenter = pack.vmet.centerRow * 1.0;
            const yShift = Math.round(dp(refCenter - myCenter));
            pushQuad(pack, penX, yShift, dp(16), dp(16), u0, v0, u1, v1);

            penX += Math.round(dp((pack.adv[lo] ?? 17)) * spacingMul);
            prevKind = 'glyph';
        };

        for (let i = 0; i < text.length; i++) {
            const cp = text.codePointAt(i);

            // SPACE
            if (cp === 32) {
                if (defaultOnly === null) {
                    // mixed: 공백 앞/뒤 타입에 따라 선택
                    const findPrev = () => {
                        for (let j = i - 1; j >= 0; j--) {
                            const c2 = text.codePointAt(j);
                            if (c2 !== 32)
                                return c2;
                        }
                        return null;
                    };
                    const findNext = () => {
                        for (let j = i + 1; j < text.length; j++) {
                            const c2 = text.codePointAt(j);
                            if (c2 !== 32)
                                return c2;
                        }
                        return null;
                    };
                    const prev = findPrev(),
                    next = findNext();
                    const bothAscii = (prev != null && isAsciiCode(prev)) && (next != null && isAsciiCode(next));
                    if (bothAscii) {
                        penX += Math.round(dp((asciiPack.adv[32] ?? 9) * ds) * spaceMul);
                    } else {
                        const advG = (glyph00 ? (glyph00.adv[32] ?? 17) : 17);
                        penX += Math.round(dp(advG) * spaceMul);
                    }
                } else if (defaultOnly) {
                    penX += Math.round(dp((asciiPack.adv[32] ?? 9) * ds) * spaceMul);
                } else {
                    const advG = (glyph00 ? (glyph00.adv[32] ?? 17) : 17);
                    penX += Math.round(dp(advG) * spaceMul);
                }
                prevKind = null; // space는 시퀀스 단절
                continue;
            }

            // 문자 렌더
            if (defaultOnly === true) {
                pushAscii(cp);
            } else if (defaultOnly === false) {
                pushGlyph(cp);
            } else {
                isAsciiCode(cp) ? pushAscii(cp) : pushGlyph(cp);
            }
        }

        // Align
        let baseX = 0;
        if (align === 'center')
            baseX = (this.canvas.width - penX) / 2;
        else if (align === 'right')
            baseX = (this.canvas.width - penX);
        const baseY = (this.canvas.height - lineH) / 2;

        // Batch by texture
        const runs = [];
        let cur = null;
        for (const s of spans) {
            if (!cur || cur.pack !== s.pack) {
                cur = {
                    pack: s.pack,
                    list: []
                };
                runs.push(cur);
            }
            cur.list.push(s);
        }

        // Render
        gl.clearColor(0.05, 0.07, 0.10, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(this.program);
        gl.uniform2f(this.loc.uRes, this.canvas.width, this.canvas.height);

        const drawRun = (run, colorArr, ox, oy) => {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, run.pack.tex);
            gl.uniform1i(this.loc.uTex, 0);
            gl.uniform4f(this.loc.uColor, colorArr[0], colorArr[1], colorArr[2], colorArr[3]);

            const verts = new Float32Array(run.list.length * 6 * 4);
            let p = 0;
            for (const q of run.list) {
                const x0 = baseX + ox + q.x,
                y0 = baseY + oy + q.y;
                const x1 = x0 + q.w,
                y1 = y0 + q.h;
                verts.set([
                        x0, y0, q.u0, q.v0,
                        x1, y0, q.u1, q.v0,
                        x0, y1, q.u0, q.v1,
                        x0, y1, q.u0, q.v1,
                        x1, y0, q.u1, q.v0,
                        x1, y1, q.u1, q.v1
                    ], p);
                p += 24;
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
            gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
            gl.drawArrays(gl.TRIANGLES, 0, verts.length / 4);
        };

        const rgbArr = [rgb[0], rgb[1], rgb[2], 1];
        if (shadow)
            for (const r of runs)
                drawRun(r, [0.266, 0.266, 0.266, 1], Math.round(scale), Math.round(scale));
        for (const r of runs)
            drawRun(r, rgbArr, 0, 0);
    }

    // ---------------------- Asset Loading ----------------------
    async _ensureGlyphPacks(set) {
        const jobs = [];
        for (const hi of set) {
            if (!this.glyphs.get(hi)) {
                jobs.push((async() => {
                        const p = await this._loadAtlas(`${this.basePath}/glyph_${hi}.png`, 16, 16, false);
                        this.glyphs.set(hi, p);
                    })());
            }
        }
        if (jobs.length)
            await Promise.all(jobs);
    }

    async _loadAtlas(url, tileW, tileH, isAscii) {
        const img = await this._loadImage(url);

        // 편집용 캔버스에 복사
        const src = document.createElement('canvas');
        src.width = img.width;
        src.height = img.height;
        const ctx = src.getContext('2d', {
            willReadFrequently: true
        });
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0);

        // (1) default8: 쉼표 픽셀 tweak + 여는 따옴표 대체 타일 생성
        if (isAscii && tileW === 8 && tileH === 8) {
            this._tweakAsciiComma(ctx);
            this._buildAsciiQuoteAlternates(ctx);
        }

        // (2) glyph_00: ASCII(32~126) 타일들의 left margin을 1px로 정규화
        if (!isAscii && tileW === 16 && tileH === 16 && /glyph_00\.png$/i.test(url)) {
            this._normalizeGlyph00LeftMargins(ctx);
        }

        // 텍스처/스캔/메트릭
        const tex = this._createTexture(src);
        const scan = this._scanAlpha(src);
        const adv = this._buildAdvance(scan, tileW, tileH);
        const vmet = this._buildVerticalMetrics(scan, tileW, tileH);
        return {
            tex,
            w: src.width,
            h: src.height,
            scan,
            adv,
            vmet
        };
    }

    _loadImage(url) {
        return new Promise((res, rej) => {
            const img = new Image();
            img.onload = () => res(img);
            img.onerror = () => rej(new Error('Failed to load ' + url));
            img.src = url;
        });
    }

    _createTexture(source) {
        const gl = this.gl;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        return tex;
    }

    _scanAlpha(source) {
        const cvs = document.createElement('canvas');
        cvs.width = source.width;
        cvs.height = source.height;
        const ctx = cvs.getContext('2d', {
            willReadFrequently: true
        });
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(source, 0, 0);
        const id = ctx.getImageData(0, 0, cvs.width, cvs.height).data;
        const alpha = new Uint8Array(cvs.width * cvs.height);
        for (let i = 0, p = 3; i < alpha.length; i++, p += 4)
            alpha[i] = id[p];
        return {
            alpha,
            width: cvs.width,
            height: cvs.height
        };
    }

    // ---------------------- Pixel Tweaks ----------------------
    // default8 쉼표(,) 살짝 오른쪽으로 이동 (행 5,6)
    _tweakAsciiComma(ctx) {
        const tileW = 8,
        tileH = 8,
        grid = 16,
        code = 44; // ','
        const cx = code % grid,
        cy = (code / grid) | 0;
        const x0 = cx * tileW,
        y0 = cy * tileH;

        const imgData = ctx.getImageData(x0, y0, tileW, tileH);
        const src = new Uint8ClampedArray(imgData.data);
        const dst = imgData.data;

        for (const py of[5, 6]) {
            for (let px = tileW - 2; px >= 0; px--) {
                const si = (py * tileW + px) * 4;
                const di = (py * tileW + (px + 1)) * 4;
                if (src[si + 3] > 0) {
                    dst[di] = src[si];
                    dst[di + 1] = src[si + 1];
                    dst[di + 2] = src[si + 2];
                    dst[di + 3] = src[si + 3];
                    dst[si] = dst[si + 1] = dst[si + 2] = dst[si + 3] = 0;
                }
            }
        }
        ctx.putImageData(imgData, x0, y0);
    }

    // glyph_00: ASCII(32~126) 타일들의 왼쪽 여백을 1px로 정규화
    _normalizeGlyph00LeftMargins(ctx) {
        const tileW = 16,
        tileH = 16,
        grid = 16;
        const start = 32,
        end = 126;

        const leftOpaqueX = (data) => {
            for (let x = 0; x < tileW; x++)
                for (let y = 0; y < tileH; y++)
                    if (data[(y * tileW + x) * 4 + 3] > 0)
                        return x;
            return -1;
        };

        for (let code = start; code <= end; code++) {
            const cx = code % grid,
            cy = (code / grid) | 0;
            const x0 = cx * tileW,
            y0 = cy * tileH;
            const srcData = ctx.getImageData(x0, y0, tileW, tileH);
            const src = srcData.data;

            const left = leftOpaqueX(src);
            if (left <= 1)
                continue; // 이미 0~1px

            const shift = left - 1; // e.g., 4→3, 2→1
            const out = ctx.createImageData(tileW, tileH);
            const dst = out.data;

            for (let y = 0; y < tileH; y++) {
                for (let x = 0; x < tileW; x++) {
                    const si = (y * tileW + x) * 4;
                    const nx = x - shift; // 왼쪽으로 당김
                    if (nx < 0)
                        continue;
                    const di = (y * tileW + nx) * 4;
                    dst[di] = src[si];
                    dst[di + 1] = src[si + 1];
                    dst[di + 2] = src[si + 2];
                    dst[di + 3] = src[si + 3];
                }
            }
            ctx.putImageData(out, x0, y0);
        }
    }

    // ASCII 따옴표 여는 방향 타일 생성 (행별 1px 이동)
    _buildAsciiQuoteAlternates(ctx) {
        const tileW = 8,
        tileH = 8,
        grid = 16;

        const buildAlt = (code, shifts) => {
            const cx = code % grid,
            cy = (code / grid) | 0;
            const x0 = cx * tileW,
            y0 = cy * tileH;
            const src = ctx.getImageData(x0, y0, tileW, tileH).data;

            const c = document.createElement('canvas');
            c.width = tileW;
            c.height = tileH;
            const dctx = c.getContext('2d', {
                willReadFrequently: true
            });
            const out = dctx.createImageData(tileW, tileH);
            const dst = out.data;

            for (let y = 0; y < tileH; y++) {
                const sh = shifts[y] || 0;
                if (sh === 0) {
                    for (let x = 0; x < tileW; x++) {
                        const si = (y * tileW + x) * 4;
                        const di = si;
                        dst[di] = src[si];
                        dst[di + 1] = src[si + 1];
                        dst[di + 2] = src[si + 2];
                        dst[di + 3] = src[si + 3];
                    }
                } else if (sh < 0) {
                    for (let x = 1; x < tileW; x++) {
                        const si = (y * tileW + x) * 4;
                        const di = (y * tileW + (x + sh)) * 4; // sh=-1 → x-1
                        dst[di] = src[si];
                        dst[di + 1] = src[si + 1];
                        dst[di + 2] = src[si + 2];
                        dst[di + 3] = src[si + 3];
                    }
                } else {
                    for (let x = tileW - 2; x >= 0; x--) {
                        const si = (y * tileW + x) * 4;
                        const di = (y * tileW + (x + sh)) * 4; // sh=+1 → x+1
                        dst[di] = src[si];
                        dst[di + 1] = src[si + 1];
                        dst[di + 2] = src[si + 2];
                        dst[di + 3] = src[si + 3];
                    }
                }
            }

            dctx.putImageData(out, 0, 0);
            return {
                tex: this._createTexture(c),
                w: tileW,
                h: tileH
            };
        };

        // 0,1행 = -1px (좌), 2행 = +1px (우), 나머지 0
        const shifts = [-1, -1, +1, 0, 0, 0, 0, 0];
        this.quoteAlt[34] = buildAlt(34, shifts); // "
        this.quoteAlt[39] = buildAlt(39, shifts); // '
    }

    // ---------------------- Metrics Builders ----------------------
    _buildAdvance(scan, tileW, tileH) {
        const grid = 16;
        const adv = new Uint16Array(256);

        const colHasOpaque = (x, y0, y1) => {
            const {
                alpha,
                width
            } = scan;
            for (let y = y0; y <= y1; y++)
                if (alpha[y * width + x] > 0)
                    return true;
            return false;
        };

        for (let idx = 0; idx < 256; idx++) {
            const cx = idx % grid,
            cy = (idx / grid) | 0;
            const x0 = cx * tileW,
            x1 = x0 + tileW - 1;
            const y0 = cy * tileH,
            y1 = y0 + tileH - 1;

            let left = x0,
            right = x1;
            for (; left <= x1; left++)
                if (colHasOpaque(left, y0, y1))
                    break;
            for (; right >= x0; right--)
                if (colHasOpaque(right, y0, y1))
                    break;

            if (right < left) {
                adv[idx] = tileW;
                continue;
            } // 빈 타일
            const visible = (right - left + 1);
            adv[idx] = visible + 1; // +1 spacing
        }
        return adv;
    }

    _buildVerticalMetrics(scan, tileW, tileH) {
        const grid = 16;
        let sumCenter = 0,
        count = 0;

        for (let idx = 0; idx < 256; idx++) {
            const cx = idx % grid,
            cy = (idx / grid) | 0;
            const x0 = cx * tileW,
            x1 = x0 + tileW - 1;
            const y0 = cy * tileH,
            y1 = y0 + tileH - 1;

            let top = -1,
            bottom = -1;
            outerTop: for (let y = y0; y <= y1; y++) {
                for (let x = x0; x <= x1; x++) {
                    if (scan.alpha[y * scan.width + x] > 0) {
                        top = y;
                        break outerTop;
                    }
                }
            }
            outerBottom: for (let y = y1; y >= y0; y--) {
                for (let x = x0; x <= x1; x++) {
                    if (scan.alpha[y * scan.width + x] > 0) {
                        bottom = y;
                        break outerBottom;
                    }
                }
            }

            if (top >= 0 && bottom >= 0) {
                sumCenter += ((top + bottom) / 2 - y0);
                count++;
            }
        }

        const centerRow = count ? (sumCenter / count) : (tileH / 2);
        return {
            centerRow,
            tileH
        };
    }

    // ---------------------- GL Utils ----------------------
    _makeProgram(vsSrc, fsSrc) {
        const gl = this.gl;
        const comp = (type, src) => {
            const s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
                throw new Error(gl.getShaderInfoLog(s));
            return s;
        };
        const p = gl.createProgram();
        gl.attachShader(p, comp(gl.VERTEX_SHADER, vsSrc));
        gl.attachShader(p, comp(gl.FRAGMENT_SHADER, fsSrc));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS))
            throw new Error(gl.getProgramInfoLog(p));
        return p;
    }

    _resize() {
        const w = this.canvas.clientWidth,
        h = this.canvas.clientHeight;
        const W = Math.round(w * this.DPR),
        H = Math.round(h * this.DPR);
        if (this.canvas.width !== W || this.canvas.height !== H) {
            this.canvas.width = W;
            this.canvas.height = H;
        }
        this.gl.viewport(0, 0, W, H);
    }

    _hexToRgb(hex) {
        const n = hex.replace('#', '');
        return [
            parseInt(n.slice(0, 2), 16) / 255,
            parseInt(n.slice(2, 4), 16) / 255,
            parseInt(n.slice(4, 6), 16) / 255
        ];
    }
}
