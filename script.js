// ============================================================
//  SETTINGS MANAGER – robust localStorage persistence
// ============================================================
const APP_SETTINGS_KEY = 'glass_newtab_settings';

function cloneDefaultSettings() {
    return {
        wallpaper: { url: '', parallax: false },
        fluid: { splatIntensity: 8, splatRadius: 0.005 },
        beat: { enabled: true, sensitivity: 2.0 },
        music: { folderLabel: '', files: [] }
    };
}

function loadAppSettings() {
    const fallback = cloneDefaultSettings();
    try {
        const raw = localStorage.getItem(APP_SETTINGS_KEY);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return {
            wallpaper: { ...fallback.wallpaper, ...(parsed.wallpaper || {}) },
            fluid: { ...fallback.fluid, ...(parsed.fluid || {}) },
            beat: { ...fallback.beat, ...(parsed.beat || {}) },
            music: { ...fallback.music, ...(parsed.music || {}) }
        };
    } catch (e) {
        return fallback;
    }
}

function saveAppSettings() {
    try {
        // Estimate size; if too large, prune music files
        let settings = window.__appSettings;
        let size = new Blob([JSON.stringify(settings)]).size;
        const MAX_SIZE = 4.5 * 1024 * 1024; // 4.5 MB
        if (size > MAX_SIZE && settings.music && settings.music.files) {
            // Prune music files to fit
            let pruned = settings.music.files.slice(0, 3);
            settings.music.files = pruned;
            // Try again
            size = new Blob([JSON.stringify(settings)]).size;
            if (size > MAX_SIZE) {
                settings.music.files = [];
            }
        }
        localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
        console.warn('Failed to save settings (quota exceeded). Pruning data...');
        // Aggressive prune: remove music files and wallpaper
        let settings = window.__appSettings;
        settings.music.files = [];
        if (settings.wallpaper && settings.wallpaper.url && settings.wallpaper.url.length > 10000) {
            settings.wallpaper.url = '';
        }
        try {
            localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(settings));
        } catch (e2) {
            console.warn('Could not save settings even after pruning.');
        }
    }
}

window.__appSettings = loadAppSettings();

// ============================================================
//  1. FLUID SIMULATION (WebGL) – with transparency
// ============================================================
(function fluidSim() {
    'use strict';

    const canvas = document.getElementById('fluid-canvas');
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;

    let config = {
        TEXTURE_DOWNSAMPLE: 1,
        DENSITY_DISSIPATION: 0.98,
        VELOCITY_DISSIPATION: 0.99,
        PRESSURE_DISSIPATION: 0.8,
        PRESSURE_ITERATIONS: 25,
        CURL: 30,
        SPLAT_RADIUS: window.__appSettings.fluid.splatRadius || 0.005,
        BEAT_SPLAT_COUNT: 3,
        BEAT_SPLAT_FORCE: 180,
        BEAT_SPLAT_LIFETIME: 0.8,
        BEAT_SPLAT_COLOR_SCALE: 0.17
    };

    let pointers = [];
    let splatStack = [];
    let persistentBeatBursts = [];

    const { gl, ext } = getWebGLContext(canvas);

    function getWebGLContext(canvas) {
        const params = { alpha: true, depth: false, stencil: false, antialias: false };
        let gl = canvas.getContext('webgl2', params);
        const isWebGL2 = !!gl;
        if (!isWebGL2)
            gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);

        let halfFloat;
        let supportLinearFiltering;
        if (isWebGL2) {
            gl.getExtension('EXT_color_buffer_float');
            supportLinearFiltering = gl.getExtension('OES_texture_float_linear');
        } else {
            halfFloat = gl.getExtension('OES_texture_half_float');
            supportLinearFiltering = gl.getExtension('OES_texture_half_float_linear');
        }

        gl.clearColor(0.0, 0.0, 0.0, 0.0); // transparent clear
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        const halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : halfFloat.HALF_FLOAT_OES;
        let formatRGBA, formatRG, formatR;
        if (isWebGL2) {
            formatRGBA = getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, halfFloatTexType);
            formatRG = getSupportedFormat(gl, gl.RG16F, gl.RG, halfFloatTexType);
            formatR = getSupportedFormat(gl, gl.R16F, gl.RED, halfFloatTexType);
        } else {
            formatRGBA = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
            formatRG = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
            formatR = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
        }
        return { gl, ext: { formatRGBA, formatRG, formatR, halfFloatTexType, supportLinearFiltering } };
    }

    function getSupportedFormat(gl, internalFormat, format, type) {
        if (!supportRenderTextureFormat(gl, internalFormat, format, type)) {
            switch (internalFormat) {
                case gl.R16F:
                    return getSupportedFormat(gl, gl.RG16F, gl.RG, type);
                case gl.RG16F:
                    return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
                default:
                    return null;
            }
        }
        return { internalFormat, format };
    }

    function supportRenderTextureFormat(gl, internalFormat, format, type) {
        let texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
        let fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status != gl.FRAMEBUFFER_COMPLETE) return false;
        return true;
    }

    function pointerPrototype() {
        this.id = -1;
        this.x = 0;
        this.y = 0;
        this.dx = 0;
        this.dy = 0;
        this.down = false;
        this.moved = false;
        this.color = [30, 0, 300];
    }
    pointers.push(new pointerPrototype());

    class GLProgram {
        constructor(vertexShader, fragmentShader) {
            this.uniforms = {};
            this.program = gl.createProgram();
            gl.attachShader(this.program, vertexShader);
            gl.attachShader(this.program, fragmentShader);
            gl.linkProgram(this.program);
            if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
                throw gl.getProgramInfoLog(this.program);
            const uniformCount = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
            for (let i = 0; i < uniformCount; i++) {
                const uniformName = gl.getActiveUniform(this.program, i).name;
                this.uniforms[uniformName] = gl.getUniformLocation(this.program, uniformName);
            }
        }
        bind() { gl.useProgram(this.program); }
    }

    function compileShader(type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
            throw gl.getShaderInfoLog(shader);
        return shader;
    }

    const baseVertexShader = compileShader(gl.VERTEX_SHADER, `
    precision highp float;
    precision mediump sampler2D;
    attribute vec2 aPosition;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform vec2 texelSize;
    void main () {
        vUv = aPosition * 0.5 + 0.5;
        vL = vUv - vec2(texelSize.x, 0.0);
        vR = vUv + vec2(texelSize.x, 0.0);
        vT = vUv + vec2(0.0, texelSize.y);
        vB = vUv - vec2(0.0, texelSize.y);
        gl_Position = vec4(aPosition, 0.0, 1.0);
    }
    `);

    const clearShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision mediump sampler2D;
    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform float value;
    void main () {
        gl_FragColor = value * texture2D(uTexture, vUv);
    }
    `);
    const displayShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision mediump sampler2D;
    varying vec2 vUv;
    uniform sampler2D uTexture;
    void main () {
        vec3 color = texture2D(uTexture, vUv).rgb;
        float alpha = max(max(color.r, color.g), color.b) * 0.75;
        gl_FragColor = vec4(color, alpha);
    }
    `);
    const splatShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision mediump sampler2D;
    varying vec2 vUv;
    uniform sampler2D uTarget;
    uniform float aspectRatio;
    uniform vec3 color;
    uniform vec2 point;
    uniform float radius;
    void main () {
        vec2 p = vUv - point.xy;
        p.x *= aspectRatio;
        vec3 splat = exp(-dot(p, p) / radius) * color;
        vec3 base = texture2D(uTarget, vUv).xyz;
        gl_FragColor = vec4(base + splat, 1.0);
    }
    `);
    const advectionManualFilteringShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision mediump sampler2D;
    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform sampler2D uSource;
    uniform vec2 texelSize;
    uniform float dt;
    uniform float dissipation;
    vec4 bilerp (in sampler2D sam, in vec2 p) {
        vec4 st;
        st.xy = floor(p - 0.5) + 0.5;
        st.zw = st.xy + 1.0;
        vec4 uv = st * texelSize.xyxy;
        vec4 a = texture2D(sam, uv.xy);
        vec4 b = texture2D(sam, uv.zy);
        vec4 c = texture2D(sam, uv.xw);
        vec4 d = texture2D(sam, uv.zw);
        vec2 f = p - st.xy;
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }
    void main () {
        vec2 coord = gl_FragCoord.xy - dt * texture2D(uVelocity, vUv).xy;
        gl_FragColor = dissipation * bilerp(uSource, coord);
        gl_FragColor.a = 1.0;
    }
    `);
    const advectionShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision mediump sampler2D;
    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform sampler2D uSource;
    uniform vec2 texelSize;
    uniform float dt;
    uniform float dissipation;
    void main () {
        vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
        gl_FragColor = dissipation * texture2D(uSource, coord);
        gl_FragColor.a = 1.0;
    }
    `);
    const divergenceShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision mediump sampler2D;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uVelocity;
    vec2 sampleVelocity (in vec2 uv) {
        vec2 multiplier = vec2(1.0, 1.0);
        if (uv.x < 0.0) { uv.x = 0.0; multiplier.x = -1.0; }
        if (uv.x > 1.0) { uv.x = 1.0; multiplier.x = -1.0; }
        if (uv.y < 0.0) { uv.y = 0.0; multiplier.y = -1.0; }
        if (uv.y > 1.0) { uv.y = 1.0; multiplier.y = -1.0; }
        return multiplier * texture2D(uVelocity, uv).xy;
    }
    void main () {
        float L = sampleVelocity(vL).x;
        float R = sampleVelocity(vR).x;
        float T = sampleVelocity(vT).y;
        float B = sampleVelocity(vB).y;
        float div = 0.5 * (R - L + T - B);
        gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
    }
    `);
    const curlShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision mediump sampler2D;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uVelocity;
    void main () {
        float L = texture2D(uVelocity, vL).y;
        float R = texture2D(uVelocity, vR).y;
        float T = texture2D(uVelocity, vT).x;
        float B = texture2D(uVelocity, vB).x;
        float vorticity = R - L - T + B;
        gl_FragColor = vec4(vorticity, 0.0, 0.0, 1.0);
    }
    `);
    const vorticityShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision mediump sampler2D;
    varying vec2 vUv;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uVelocity;
    uniform sampler2D uCurl;
    uniform float curl;
    uniform float dt;
    void main () {
        float T = texture2D(uCurl, vT).x;
        float B = texture2D(uCurl, vB).x;
        float C = texture2D(uCurl, vUv).x;
        vec2 force = vec2(abs(T) - abs(B), 0.0);
        force *= 1.0 / length(force + 0.00001) * curl * C;
        vec2 vel = texture2D(uVelocity, vUv).xy;
        gl_FragColor = vec4(vel + force * dt, 0.0, 1.0);
    }
    `);
    const pressureShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision mediump sampler2D;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uPressure;
    uniform sampler2D uDivergence;
    vec2 boundary (in vec2 uv) {
        uv = min(max(uv, 0.0), 1.0);
        return uv;
    }
    void main () {
        float L = texture2D(uPressure, boundary(vL)).x;
        float R = texture2D(uPressure, boundary(vR)).x;
        float T = texture2D(uPressure, boundary(vT)).x;
        float B = texture2D(uPressure, boundary(vB)).x;
        float C = texture2D(uPressure, vUv).x;
        float divergence = texture2D(uDivergence, vUv).x;
        float pressure = (L + R + B + T - divergence) * 0.25;
        gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
    }
    `);
    const gradientSubtractShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision mediump sampler2D;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uPressure;
    uniform sampler2D uVelocity;
    vec2 boundary (in vec2 uv) {
        uv = min(max(uv, 0.0), 1.0);
        return uv;
    }
    void main () {
        float L = texture2D(uPressure, boundary(vL)).x;
        float R = texture2D(uPressure, boundary(vR)).x;
        float T = texture2D(uPressure, boundary(vT)).x;
        float B = texture2D(uPressure, boundary(vB)).x;
        vec2 velocity = texture2D(uVelocity, vUv).xy;
        velocity.xy -= vec2(R - L, T - B);
        gl_FragColor = vec4(velocity, 0.0, 1.0);
    }
    `);

    let textureWidth, textureHeight;
    let density, velocity, divergence, curl, pressure;
    initFramebuffers();

    const clearProgram = new GLProgram(baseVertexShader, clearShader);
    const displayProgram = new GLProgram(baseVertexShader, displayShader);
    const splatProgram = new GLProgram(baseVertexShader, splatShader);
    const advectionProgram = new GLProgram(baseVertexShader, ext.supportLinearFiltering ? advectionShader :
        advectionManualFilteringShader);
    const divergenceProgram = new GLProgram(baseVertexShader, divergenceShader);
    const curlProgram = new GLProgram(baseVertexShader, curlShader);
    const vorticityProgram = new GLProgram(baseVertexShader, vorticityShader);
    const pressureProgram = new GLProgram(baseVertexShader, pressureShader);
    const gradienSubtractProgram = new GLProgram(baseVertexShader, gradientSubtractShader);

    function initFramebuffers() {
        textureWidth = gl.drawingBufferWidth >> config.TEXTURE_DOWNSAMPLE;
        textureHeight = gl.drawingBufferHeight >> config.TEXTURE_DOWNSAMPLE;
        const texType = ext.halfFloatTexType;
        const rgba = ext.formatRGBA,
            rg = ext.formatRG,
            r = ext.formatR;
        density = createDoubleFBO(2, textureWidth, textureHeight, rgba.internalFormat, rgba.format, texType, ext
            .supportLinearFiltering ? gl.LINEAR : gl.NEAREST);
        velocity = createDoubleFBO(0, textureWidth, textureHeight, rg.internalFormat, rg.format, texType, ext
            .supportLinearFiltering ? gl.LINEAR : gl.NEAREST);
        divergence = createFBO(4, textureWidth, textureHeight, r.internalFormat, r.format, texType, gl.NEAREST);
        curl = createFBO(5, textureWidth, textureHeight, r.internalFormat, r.format, texType, gl.NEAREST);
        pressure = createDoubleFBO(6, textureWidth, textureHeight, r.internalFormat, r.format, texType, gl.NEAREST);
    }

    function createFBO(texId, w, h, internalFormat, format, type, param) {
        gl.activeTexture(gl.TEXTURE0 + texId);
        let texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
        let fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        gl.viewport(0, 0, w, h);
        gl.clear(gl.COLOR_BUFFER_BIT);
        return [texture, fbo, texId];
    }

    function createDoubleFBO(texId, w, h, internalFormat, format, type, param) {
        let fbo1 = createFBO(texId, w, h, internalFormat, format, type, param);
        let fbo2 = createFBO(texId + 1, w, h, internalFormat, format, type, param);
        return {
            get read() { return fbo1; },
            get write() { return fbo2; },
            swap() { let temp = fbo1;
                fbo1 = fbo2;
                fbo2 = temp; }
        };
    }

    const blit = (() => {
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(0);
        return (destination) => {
            gl.bindFramebuffer(gl.FRAMEBUFFER, destination);
            gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
        };
    })();

    let lastTime = Date.now();

    function splat(x, y, dx, dy, color, radius = config.SPLAT_RADIUS) {
        const clampedX = Math.max(0, Math.min(canvas.width, x));
        const clampedY = Math.max(0, Math.min(canvas.height, y));
        splatProgram.bind();
        gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read[2]);
        gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
        gl.uniform2f(splatProgram.uniforms.point, clampedX / canvas.width, 1.0 - clampedY / canvas.height);
        gl.uniform3f(splatProgram.uniforms.color, dx, -dy, 1.0);
        gl.uniform1f(splatProgram.uniforms.radius, radius);
        blit(velocity.write[1]);
        velocity.swap();
        gl.uniform1i(splatProgram.uniforms.uTarget, density.read[2]);
        gl.uniform3f(splatProgram.uniforms.color, color[0] * 0.3, color[1] * 0.3, color[2] * 0.3);
        blit(density.write[1]);
        density.swap();
    }

    function multipleSplats(amount, options = {}) {
        const radius = options.radius ?? config.SPLAT_RADIUS;
        const force = options.force ?? 1000;
        for (let i = 0; i < amount; i++) {
            const color = [4 + Math.random() * 8, 4 + Math.random() * 8, 4 + Math.random() * 8];
            const x = canvas.width * Math.random();
            const y = canvas.height * Math.random();
            const dx = (Math.random() - 0.5) * force;
            const dy = (Math.random() - 0.5) * force;
            splat(x, y, dx, dy, color, radius);
        }
    }

    function beatSplats() {
        const count = config.BEAT_SPLAT_COUNT;
        const radius = config.SPLAT_RADIUS * 0.65;
        const force = config.BEAT_SPLAT_FORCE;
        for (let i = 0; i < count; i++) {
            const base = [1.8 + Math.random() * 2.4, 1.8 + Math.random() * 2.4, 1.8 + Math.random() * 2.4];
            const color = base.map(v => v * config.BEAT_SPLAT_COLOR_SCALE);
            const x = canvas.width * (0.1 + Math.random() * 0.8);
            const y = canvas.height * (0.1 + Math.random() * 0.8);
            const angle = Math.random() * Math.PI * 2;
            const dx = Math.cos(angle) * (60 + Math.random() * force);
            const dy = Math.sin(angle) * (60 + Math.random() * force);
            persistentBeatBursts.push({
                x,
                y,
                dx,
                dy,
                color,
                radius,
                age: 0,
                life: config.BEAT_SPLAT_LIFETIME * (0.8 + Math.random() * 0.8)
            });
        }
    }

    function updatePersistentBeatBursts(dt) {
        if (persistentBeatBursts.length === 0) return;
        for (let i = persistentBeatBursts.length - 1; i >= 0; i--) {
            const p = persistentBeatBursts[i];
            p.age += dt;
            const progress = Math.max(0, 1.0 - p.age / p.life);
            const intensity = Math.max(0.13, progress);
            p.x = Math.max(0, Math.min(canvas.width, p.x + p.dx * dt));
            p.y = Math.max(0, Math.min(canvas.height, p.y + p.dy * dt));
            p.dx *= 0.986;
            p.dy *= 0.986;

            const color = p.color.map(v => v * (0.5 + intensity * 0.7));
            splat(p.x, p.y, p.dx * intensity, p.dy * intensity, color, p.radius);

            if (p.age >= p.life) {
                persistentBeatBursts.splice(i, 1);
            }
        }
    }

    window.__fluid = {
        multipleSplats: multipleSplats,
        beatSplats: beatSplats,
        cornerSplats: beatSplats,
        splat: splat,
        setSplatRadius: (r) => { config.SPLAT_RADIUS = r; },
        getSplatRadius: () => config.SPLAT_RADIUS,
        canvas: canvas
    };

    function resizeCanvas() {
        if (canvas.width != canvas.clientWidth || canvas.height != canvas.clientHeight) {
            canvas.width = canvas.clientWidth;
            canvas.height = canvas.clientHeight;
            initFramebuffers();
        }
    }

    function getCanvasCoords(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        return { x: clientX - rect.left, y: clientY - rect.top };
    }

    document.addEventListener('mousemove', (e) => {
        const p = getCanvasCoords(e.clientX, e.clientY);
        const ptr = pointers[0];
        ptr.moved = ptr.down;
        ptr.dx = (p.x - ptr.x) * 10.0;
        ptr.dy = (p.y - ptr.y) * 10.0;
        ptr.x = p.x;
        ptr.y = p.y;
    });
    document.addEventListener('mousedown', (e) => {
        const p = getCanvasCoords(e.clientX, e.clientY);
        const ptr = pointers[0];
        ptr.down = true;
        ptr.x = p.x;
        ptr.y = p.y;
        ptr.color = [Math.random() + 0.2, Math.random() + 0.2, Math.random() + 0.2];
        ptr.dx = 0;
        ptr.dy = 0;
        ptr.moved = true;
    });
    document.addEventListener('mouseup', () => { pointers[0].down = false; });

    document.addEventListener('touchmove', (e) => {
        e.preventDefault();
        const touches = e.targetTouches;
        for (let i = 0; i < touches.length; i++) {
            const p = getCanvasCoords(touches[i].clientX, touches[i].clientY);
            let ptr = pointers[i];
            if (!ptr) { ptr = new pointerPrototype();
                pointers[i] = ptr; }
            ptr.moved = ptr.down;
            ptr.dx = (p.x - ptr.x) * 10.0;
            ptr.dy = (p.y - ptr.y) * 10.0;
            ptr.x = p.x;
            ptr.y = p.y;
        }
    }, { passive: false });
    document.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const touches = e.targetTouches;
        for (let i = 0; i < touches.length; i++) {
            const p = getCanvasCoords(touches[i].clientX, touches[i].clientY);
            if (i >= pointers.length) pointers.push(new pointerPrototype());
            const ptr = pointers[i];
            ptr.id = touches[i].identifier;
            ptr.down = true;
            ptr.x = p.x;
            ptr.y = p.y;
            ptr.color = [Math.random() + 0.2, Math.random() + 0.2, Math.random() + 0.2];
            ptr.dx = 0;
            ptr.dy = 0;
            ptr.moved = true;
        }
    }, { passive: false });
    document.addEventListener('touchend', (e) => {
        const touches = e.changedTouches;
        for (let i = 0; i < touches.length; i++) {
            for (let j = 0; j < pointers.length; j++) {
                if (touches[i].identifier == pointers[j].id) { pointers[j].down = false; }
            }
        }
    });

    function update() {
        resizeCanvas();
        const dt = Math.min((Date.now() - lastTime) / 1000, 0.016);
        lastTime = Date.now();
        gl.viewport(0, 0, textureWidth, textureHeight);
        if (splatStack.length > 0) multipleSplats(splatStack.pop());
        updatePersistentBeatBursts(dt);

        advectionProgram.bind();
        gl.uniform2f(advectionProgram.uniforms.texelSize, 1.0 / textureWidth, 1.0 / textureHeight);
        gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read[2]);
        gl.uniform1i(advectionProgram.uniforms.uSource, velocity.read[2]);
        gl.uniform1f(advectionProgram.uniforms.dt, dt);
        gl.uniform1f(advectionProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
        blit(velocity.write[1]);
        velocity.swap();
        gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read[2]);
        gl.uniform1i(advectionProgram.uniforms.uSource, density.read[2]);
        gl.uniform1f(advectionProgram.uniforms.dissipation, config.DENSITY_DISSIPATION);
        blit(density.write[1]);
        density.swap();

        for (let i = 0; i < pointers.length; i++) {
            const pointer = pointers[i];
            if (pointer.moved) {
                splat(pointer.x, pointer.y, pointer.dx, pointer.dy, pointer.color);
                pointer.moved = false;
            }
        }

        curlProgram.bind();
        gl.uniform2f(curlProgram.uniforms.texelSize, 1.0 / textureWidth, 1.0 / textureHeight);
        gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read[2]);
        blit(curl[1]);
        vorticityProgram.bind();
        gl.uniform2f(vorticityProgram.uniforms.texelSize, 1.0 / textureWidth, 1.0 / textureHeight);
        gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read[2]);
        gl.uniform1i(vorticityProgram.uniforms.uCurl, curl[2]);
        gl.uniform1f(vorticityProgram.uniforms.curl, config.CURL);
        gl.uniform1f(vorticityProgram.uniforms.dt, dt);
        blit(velocity.write[1]);
        velocity.swap();
        divergenceProgram.bind();
        gl.uniform2f(divergenceProgram.uniforms.texelSize, 1.0 / textureWidth, 1.0 / textureHeight);
        gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read[2]);
        blit(divergence[1]);
        clearProgram.bind();
        let pressureTexId = pressure.read[2];
        gl.activeTexture(gl.TEXTURE0 + pressureTexId);
        gl.bindTexture(gl.TEXTURE_2D, pressure.read[0]);
        gl.uniform1i(clearProgram.uniforms.uTexture, pressureTexId);
        gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE_DISSIPATION);
        blit(pressure.write[1]);
        pressure.swap();
        pressureProgram.bind();
        gl.uniform2f(pressureProgram.uniforms.texelSize, 1.0 / textureWidth, 1.0 / textureHeight);
        gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence[2]);
        pressureTexId = pressure.read[2];
        gl.uniform1i(pressureProgram.uniforms.uPressure, pressureTexId);
        gl.activeTexture(gl.TEXTURE0 + pressureTexId);
        for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
            gl.bindTexture(gl.TEXTURE_2D, pressure.read[0]);
            blit(pressure.write[1]);
            pressure.swap();
        }
        gradienSubtractProgram.bind();
        gl.uniform2f(gradienSubtractProgram.uniforms.texelSize, 1.0 / textureWidth, 1.0 / textureHeight);
        gl.uniform1i(gradienSubtractProgram.uniforms.uPressure, pressure.read[2]);
        gl.uniform1i(gradienSubtractProgram.uniforms.uVelocity, velocity.read[2]);
        blit(velocity.write[1]);
        velocity.swap();
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        displayProgram.bind();
        gl.uniform1i(displayProgram.uniforms.uTexture, density.read[2]);
        blit(null);
        requestAnimationFrame(update);
    }

    // initial splat burst
    multipleSplats(parseInt(Math.random() * 20) + 5);
    update();
})();


// ============================================================
//  2. UI LOGIC – Glass + Search + Sidepanels
// ============================================================
(function uiLogic() {
    'use strict';

    const searchInput = document.getElementById('searchInput');
    const searchWrapper = document.getElementById('searchWrapper');
    const plusBtn = document.getElementById('plusBtn');
    const lensFileInput = document.getElementById('lensFileInput');
    const lensForm = document.getElementById('lensForm');
    const lensTextInput = document.getElementById('lensTextInput');
    const imagePreview = document.getElementById('imagePreview');
    const previewImg = document.getElementById('previewImg');
    const removeImgBtn = document.getElementById('removeImg');
    const thumbBadge = document.getElementById('thumbBadge');
    const searchBar = document.getElementById('searchBar');

    let attachedFile = null;
    let isFocused = false;
    let isOpeningFilePicker = false;

    const songsPanel = document.getElementById('songsPanel');
    const settingsPanel = document.getElementById('settingsPanel');
    const songsToggle = document.getElementById('songsToggle');
    const settingsToggle = document.getElementById('settingsToggle');
    const songsClose = document.getElementById('songsClose');
    const settingsClose = document.getElementById('settingsClose');

    function openSongs() { songsPanel.classList.add('open'); }

    function closeSongs() { songsPanel.classList.remove('open'); }

    function openSettings() { settingsPanel.classList.add('open'); }

    function closeSettings() { settingsPanel.classList.remove('open'); }

    songsToggle.addEventListener('click', () => {
        if (songsPanel.classList.contains('open')) closeSongs();
        else { closeSettings();
            openSongs(); }
    });
    settingsToggle.addEventListener('click', () => {
        if (settingsPanel.classList.contains('open')) closeSettings();
        else { closeSongs();
            openSettings(); }
    });
    songsClose.addEventListener('click', closeSongs);
    settingsClose.addEventListener('click', closeSettings);

    document.addEventListener('mousedown', (e) => {
        const target = e.target;
        if (songsPanel.classList.contains('open')) {
            if (!songsPanel.contains(target) && target !== songsToggle && !songsToggle.contains(target)) {
                closeSongs();
            }
        }
        if (settingsPanel.classList.contains('open')) {
            if (!settingsPanel.contains(target) && target !== settingsToggle && !settingsToggle.contains(
                target)) {
                closeSettings();
            }
        }
    });

    searchInput.addEventListener('focus', () => {
        isFocused = true;
        searchWrapper.classList.remove('unfocused');
        searchWrapper.classList.add('focused');
        updatePlusState();
    });

    searchInput.addEventListener('blur', () => {
        if (isOpeningFilePicker) {
            searchInput.focus();
            isOpeningFilePicker = false;
            return;
        }
        isFocused = false;
        searchWrapper.classList.remove('focused');
        searchWrapper.classList.add('unfocused');
        updatePlusState();
    });

    searchWrapper.addEventListener('mousedown', (e) => {
        if (e.target === searchInput) return;
        e.preventDefault();
    });

    searchBar.addEventListener('mousedown', (e) => {
        if (e.target === searchInput) return;
        if (!e.target.closest('.plus-btn') && !e.target.closest('.remove-img')) {
            searchInput.focus();
        }
    });

    plusBtn.addEventListener('mousedown', (e) => e.preventDefault());
    plusBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (attachedFile) {
            removeAttachedImage();
        } else {
            isOpeningFilePicker = true;
            lensFileInput.click();
            setTimeout(() => { isOpeningFilePicker = false; }, 1000);
        }
    });

    lensFileInput.addEventListener('change', function() {
        isOpeningFilePicker = false;
        if (this.files.length > 0) {
            const file = this.files[0];
            if (file.type.startsWith('image/')) attachImage(file);
        }
        this.value = '';
        searchInput.focus();
    });

    lensFileInput.addEventListener('blur', function() {
        if (isOpeningFilePicker) { isOpeningFilePicker = false;
            searchInput.focus(); }
    });

    function attachImage(file) {
        attachedFile = file;
        const reader = new FileReader();
        reader.onload = (e) => {
            previewImg.src = e.target.result;
            imagePreview.classList.add('active');
            updatePlusState();
        };
        reader.readAsDataURL(file);
        searchInput.focus();
    }

    function removeAttachedImage() {
        attachedFile = null;
        imagePreview.classList.remove('active');
        previewImg.src = '';
        updatePlusState();
        lensFileInput.value = '';
        searchInput.focus();
    }

    removeImgBtn.addEventListener('mousedown', (e) => e.preventDefault());
    removeImgBtn.addEventListener('click', (e) => { e.stopPropagation();
        removeAttachedImage(); });

    function updatePlusState() {
        if (attachedFile) {
            plusBtn.classList.add('has-image');
            thumbBadge.textContent = '1';
        } else {
            plusBtn.classList.remove('has-image');
        }
    }

    document.addEventListener('keydown', (e) => {
        if (e.target === searchInput) return;
        if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            searchInput.focus();
            searchInput.select();
        }
        if (e.key === 'r' && !e.ctrlKey && !e.metaKey && !e.altKey) {
            if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
            triggerRandomSplats();
        }
        if (e.key === 'Escape') {
            if (songsPanel.classList.contains('open')) closeSongs();
            if (settingsPanel.classList.contains('open')) closeSettings();
        }
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !e.key.match(/[\s]/)) {
            if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
            searchInput.focus();
        }
    });

    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const query = searchInput.value.trim();
            if (attachedFile) {
                searchWithLens(query);
            } else if (query) {
                let url;
                if (query.includes('.') && !query.includes(' ') && !query.includes('://')) {
                    url = query.startsWith('http') ? query : 'https://' + query;
                } else {
                    url = 'https://www.google.com/search?q=' + encodeURIComponent(query);
                }
                window.location.href = url;
            }
        }
    });

    function searchWithLens(query) {
        if (!attachedFile) return;
        lensTextInput.value = query || '';
        lensForm.submit();
        setTimeout(() => { removeAttachedImage();
            searchInput.value = ''; }, 500);
    }

    function triggerRandomSplats() {
        const count = parseInt(document.getElementById('splatIntensity').value) || 8;
        const fluid = window.__fluid;
        if (fluid) fluid.multipleSplats(count);
    }

    window.__ui = { triggerRandomSplats, closeSongs, closeSettings };

    function updateClock() {
        const now = new Date();
        const h = String(now.getHours()).padStart(2, '0');
        const m = String(now.getMinutes()).padStart(2, '0');
        document.getElementById('timeDisplay').textContent = h + ':' + m;
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const d = days[now.getDay()];
        const mo = months[now.getMonth()];
        const da = now.getDate();
        document.getElementById('dateDisplay').textContent = d + ' ' + mo + ' ' + da;
        const hr = now.getHours();
        let greeting = 'Good evening';
        if (hr < 12) greeting = 'Good morning';
        else if (hr < 17) greeting = 'Good afternoon';
        document.getElementById('greeting').innerHTML = '<i class="far fa-clock"></i> ' + greeting;
    }
    updateClock();
    setInterval(updateClock, 30000);

    searchWrapper.classList.add('unfocused');
    updatePlusState();

    console.log('Glass New Tab — UI ready');
})();


// ============================================================
//  3. MUSIC PLAYER + BEAT DETECTION + AUTO-LOAD
// ============================================================
(function musicPlayer() {
    'use strict';

    const fluid = window.__fluid;
    const songsList = document.getElementById('songsList');
    const songsEmpty = document.getElementById('songsEmpty');
    const selectFolderBtn = document.getElementById('selectFolderBtn');
    const folderInput = document.getElementById('folderInput');
    const playerControls = document.getElementById('playerControls');
    const playBtn = document.getElementById('playBtn');
    const playIcon = document.getElementById('playIcon');
    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');
    const progressFill = document.getElementById('progressFill');
    const progressBar = document.getElementById('progressBar');
    const currentTimeEl = document.getElementById('currentTime');
    const totalTimeEl = document.getElementById('totalTime');
    const volSlider = document.getElementById('volSlider');
    const volIcon = document.getElementById('volIcon');
    const nowPlaying = document.getElementById('nowPlaying');
    const beatIndicator = document.getElementById('beatIndicator');
    const beatFlash = document.getElementById('beatFlash');
    const songBadge = document.getElementById('songBadge');

    const beatToggle = document.getElementById('beatToggle');
    const beatSensitivitySlider = document.getElementById('beatSensitivity');
    const beatSensitivityVal = document.getElementById('beatSensitivityVal');

    let songs = [];
    let currentIndex = -1;
    let audio = null;
    let audioCtx = null;
    let analyser = null;
    let source = null;
    let isPlaying = false;
    let isBeatSync = window.__appSettings.beat.enabled !== false;
    let beatSensitivity = Number(window.__appSettings.beat.sensitivity) || 2.0;
    let beatHistory = [];
    let lastBeatTime = 0;
    let beatCooldown = 0.12;
    let rafId = null;
    let volume = 0.8;
    volSlider.value = volume;

    function loadStoredMusic() {
        const musicData = window.__appSettings.music;
        if (!musicData || !musicData.files || musicData.files.length === 0) {
            return false;
        }
        try {
            const fileEntries = musicData.files.slice(0, 5);
            const reconstructed = [];
            for (const entry of fileEntries) {
                if (entry.data && entry.name) {
                    const blob = dataURLToBlob(entry.data);
                    const file = new File([blob], entry.name, { type: blob.type || 'audio/mpeg' });
                    reconstructed.push({
                        id: reconstructed.length,
                        file: file,
                        name: entry.name.replace(/\.[^/.]+$/, ''),
                        url: URL.createObjectURL(file)
                    });
                }
            }
            if (reconstructed.length === 0) return false;
            songs = reconstructed;
            renderSongs();
            songsEmpty.style.display = 'none';
            songsList.style.display = 'flex';
            playerControls.style.display = 'block';
            songBadge.textContent = songs.length;
            songBadge.classList.add('show');
            if (songs.length > 0) playSong(0);
            return true;
        } catch (e) {
            console.warn('Failed to load stored music:', e);
            return false;
        }
    }

    function dataURLToBlob(dataURL) {
        const parts = dataURL.split(',');
        const mime = parts[0].match(/:(.*?);/)[1];
        const bstr = atob(parts[1]);
        const n = bstr.length;
        const u8arr = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            u8arr[i] = bstr.charCodeAt(i);
        }
        return new Blob([u8arr], { type: mime });
    }

    selectFolderBtn.addEventListener('click', () => folderInput.click());

    folderInput.addEventListener('change', function() {
        if (this.files.length === 0) return;
        const files = Array.from(this.files);
        const audioFiles = files.filter(f =>
            f.type.startsWith('audio/') || f.name.match(/\.(mp3|wav|aac|flac|ogg|m4a)$/i)
        );
        if (audioFiles.length === 0) {
            alert('No audio files found in the selected folder.');
            return;
        }
        // Limit to 5 files to avoid storage issues
        const limited = audioFiles.slice(0, 5);
        const readerPromises = limited.map((f) => {
            return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = (e) => {
                    resolve({ name: f.name, data: e.target.result, type: f.type });
                };
                reader.readAsDataURL(f);
            });
        });
        Promise.all(readerPromises).then((results) => {
            const folderLabel = getFolderLabelFromFiles(files) || 'Music';
            window.__appSettings.music.folderLabel = folderLabel;
            window.__appSettings.music.files = results;
            saveAppSettings();
            loadStoredMusic();
            document.getElementById('songsPanel').classList.add('open');
        }).catch((err) => {
            console.warn('Failed to read audio files:', err);
            alert('Failed to read audio files. Please try again.');
        });
        this.value = '';
    });

    function getFolderLabelFromFiles(files) {
        const rel = files.map(f => f.webkitRelativePath || f.name || '').find(Boolean);
        if (!rel) return '';
        const parts = rel.split('/');
        return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    }

    function initializeMusicLibrary() {
        const loaded = loadStoredMusic();
        if (!loaded) {
            songsEmpty.style.display = 'block';
            songsList.style.display = 'none';
        }
    }

    initializeMusicLibrary();

    function renderSongs() {
        songsList.innerHTML = '';
        songs.forEach((song, i) => {
            const div = document.createElement('div');
            div.className = 'song-item' + (i === currentIndex ? ' active' : '');
            div.innerHTML = `
        <span class="index">${i + 1}</span>
        <div class="info">
            <div class="title">${escapeHtml(song.name)}</div>
            <div class="artist">${escapeHtml(song.file.name.split('/').pop() || 'Unknown')}</div>
        </div>
        <span class="play-indicator">${i === currentIndex && isPlaying ? '<i class="fas fa-play"></i>' : ''}</span>
        <span class="duration">${i === currentIndex ? formatTime(audio ? audio.duration : 0) : ''}</span>
        `;
            div.addEventListener('click', () => { playSong(i); });
            songsList.appendChild(div);
        });
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return '0:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return m + ':' + String(s).padStart(2, '0');
    }

    function playSong(index) {
        if (index < 0 || index >= songs.length) return;
        if (audio) {
            audio.pause();
            audio.src = '';
            if (source) { try { source.disconnect(); } catch (e) {} }
        }
        currentIndex = index;
        const song = songs[index];
        audio = new Audio(song.url);
        audio.volume = volume;
        audio.preload = 'auto';

        if (!audioCtx) {
            audioCtx = new(window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.3;

        source = audioCtx.createMediaElementSource(audio);
        source.connect(analyser);
        analyser.connect(audioCtx.destination);

        audio.addEventListener('ended', () => {
            isPlaying = false;
            updatePlayButton();
            nextSong();
        });

        audio.addEventListener('timeupdate', updateProgress);
        audio.addEventListener('loadedmetadata', () => {
            totalTimeEl.textContent = formatTime(audio.duration);
            updateSongList();
        });

        audio.play().then(() => {
            isPlaying = true;
            updatePlayButton();
            updateSongList();
            nowPlaying.innerHTML =
                `<i class="fas fa-headphones"></i> <strong>${escapeHtml(song.name)}</strong>`;
            if (isBeatSync) startBeatDetection();
        }).catch(err => {
            console.warn('Playback error:', err);
            isPlaying = false;
            updatePlayButton();
        });
    }

    function togglePlay() {
        if (!audio) {
            if (songs.length > 0) playSong(0);
            return;
        }
        if (isPlaying) {
            audio.pause();
            isPlaying = false;
            stopBeatDetection();
        } else {
            audio.play().then(() => {
                isPlaying = true;
                if (isBeatSync) startBeatDetection();
            }).catch(() => {});
        }
        updatePlayButton();
        updateSongList();
    }

    function prevSong() {
        if (songs.length === 0) return;
        const idx = (currentIndex - 1 + songs.length) % songs.length;
        playSong(idx);
    }

    function nextSong() {
        if (songs.length === 0) return;
        const idx = (currentIndex + 1) % songs.length;
        playSong(idx);
    }

    function updatePlayButton() {
        if (isPlaying) {
            playIcon.className = 'fas fa-pause';
        } else {
            playIcon.className = 'fas fa-play';
        }
    }

    function updateProgress() {
        if (!audio || !audio.duration) return;
        const pct = (audio.currentTime / audio.duration) * 100;
        progressFill.style.width = pct + '%';
        currentTimeEl.textContent = formatTime(audio.currentTime);
        totalTimeEl.textContent = formatTime(audio.duration);
    }

    function updateSongList() {
        const items = songsList.querySelectorAll('.song-item');
        items.forEach((el, i) => {
            el.classList.toggle('active', i === currentIndex);
            const indicator = el.querySelector('.play-indicator');
            if (i === currentIndex && isPlaying) {
                indicator.innerHTML = '<i class="fas fa-play"></i>';
            } else if (i === currentIndex) {
                indicator.innerHTML = '<i class="fas fa-pause"></i>';
            } else {
                indicator.innerHTML = '';
            }
            const dur = el.querySelector('.duration');
            if (i === currentIndex && audio && audio.duration) {
                dur.textContent = formatTime(audio.currentTime) + '/' + formatTime(audio.duration);
            } else {
                dur.textContent = '';
            }
        });
    }

    progressBar.addEventListener('click', (e) => {
        if (!audio || !audio.duration) return;
        const rect = progressBar.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        audio.currentTime = pct * audio.duration;
    });

    volSlider.addEventListener('input', () => {
        volume = parseFloat(volSlider.value);
        if (audio) audio.volume = volume;
        volIcon.innerHTML = volume < 0.01 ? '<i class="fas fa-volume-mute"></i>' :
            volume < 0.4 ? '<i class="fas fa-volume-down"></i>' :
            '<i class="fas fa-volume-up"></i>';
    });

    function startBeatDetection() {
        stopBeatDetection();
        if (!analyser) return;
        beatHistory = [];
        lastBeatTime = 0;
        detectBeatLoop();
    }

    function stopBeatDetection() {
        if (rafId) { cancelAnimationFrame(rafId);
            rafId = null; }
        beatIndicator.classList.remove('active');
        beatFlash.classList.remove('active');
    }

    function detectBeatLoop() {
        if (!isPlaying || !analyser || !isBeatSync) {
            rafId = null;
            return;
        }
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);

        let energy = 0;
        const count = Math.min(40, data.length);
        for (let i = 0; i < count; i++) {
            energy += data[i] * data[i];
        }
        energy = Math.sqrt(energy / count) / 255;

        beatHistory.push(energy);
        if (beatHistory.length > 43) beatHistory.shift();
        const avg = beatHistory.reduce((a, b) => a + b, 0) / beatHistory.length;
        const threshold = avg * beatSensitivity;

        const now = performance.now() / 1000;
        if (energy > threshold && (now - lastBeatTime) > beatCooldown) {
            lastBeatTime = now;
            beatIndicator.classList.add('active');
            beatFlash.classList.add('active');
            setTimeout(() => beatFlash.classList.remove('active'), 60);
            setTimeout(() => beatIndicator.classList.remove('active'), 120);
            if (fluid) fluid.beatSplats();
        }

        rafId = requestAnimationFrame(detectBeatLoop);
    }

    beatToggle.classList.toggle('on', isBeatSync);
    beatSensitivitySlider.value = String(beatSensitivity);
    beatSensitivityVal.textContent = beatSensitivity.toFixed(1);

    beatToggle.addEventListener('click', () => {
        isBeatSync = !isBeatSync;
        beatToggle.classList.toggle('on', isBeatSync);
        window.__appSettings.beat.enabled = isBeatSync;
        saveAppSettings();
        if (isBeatSync && isPlaying) startBeatDetection();
        else stopBeatDetection();
    });

    beatSensitivitySlider.addEventListener('input', () => {
        beatSensitivity = parseFloat(beatSensitivitySlider.value);
        beatSensitivityVal.textContent = beatSensitivity.toFixed(1);
        window.__appSettings.beat.sensitivity = beatSensitivity;
        saveAppSettings();
    });

    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT') return;
        if (e.key === ' ' || e.key === 'Space') {
            e.preventDefault();
            togglePlay();
        }
        if (e.key === 'ArrowRight' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            nextSong();
        }
        if (e.key === 'ArrowLeft' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            prevSong();
        }
    });

    playBtn.addEventListener('click', togglePlay);
    prevBtn.addEventListener('click', prevSong);
    nextBtn.addEventListener('click', nextSong);

    console.log('Music player + beat detection ready');
})();


// ============================================================
//  4. WALLPAPER + PARALLAX + TEMPERATURE – with compression
// ============================================================
(function wallpaperAndWeather() {
    'use strict';

    const layer = document.getElementById('wallpaper-layer');
    const fileInput = document.getElementById('wallpaperFileInput');
    const wallpaperBtn = document.getElementById('wallpaperBtn');
    const resetBtn = document.getElementById('resetWallpaperBtn');
    const parallaxToggle = document.getElementById('parallaxToggle');
    const tempDisplay = document.getElementById('tempDisplay');
    const weatherIcon = document.getElementById('weatherIcon');

    let isParallax = !!window.__appSettings.wallpaper.parallax;
    let imageUrl = window.__appSettings.wallpaper.url || null;

    function applyWallpaper(url) {
        if (url && url.length > 0) {
            layer.style.backgroundImage = 'url(' + url + ')';
            layer.style.background = 'transparent';
            layer.classList.add('has-image');
        } else {
            layer.style.backgroundImage = 'none';
            layer.style.background = '#0a0a0f';
            layer.classList.remove('has-image');
        }
    }

    // Restore
    if (imageUrl && imageUrl.length > 0) {
        applyWallpaper(imageUrl);
        if (isParallax) {
            parallaxToggle.classList.add('on');
            layer.classList.add('parallax');
        }
    }

    // ---- upload with compression ----
    wallpaperBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', function() {
        if (this.files.length === 0) return;
        const file = this.files[0];
        // Limit to 5MB raw, but we'll compress
        const reader = new FileReader();
        reader.onload = function(e) {
            const img = new Image();
            img.onload = function() {
                // Compress: resize to max 1200px, quality 0.7 JPEG
                let w = img.width,
                    h = img.height;
                const maxDim = 1200;
                if (w > maxDim || h > maxDim) {
                    const scale = Math.min(maxDim / w, maxDim / h);
                    w = Math.round(w * scale);
                    h = Math.round(h * scale);
                }
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
                const compressed = canvas.toDataURL('image/jpeg', 0.7);
                imageUrl = compressed;
                applyWallpaper(compressed);
                window.__appSettings.wallpaper.url = compressed;
                saveAppSettings();
            };
            img.onerror = function() {
                alert('Failed to load image.');
            };
            img.src = e.target.result;
        };
        reader.onerror = function() {
            alert('Failed to read file.');
        };
        reader.readAsDataURL(file);
        this.value = '';
    });

    // ---- reset ----
    resetBtn.addEventListener('click', () => {
        imageUrl = null;
        applyWallpaper(null);
        window.__appSettings.wallpaper.url = '';
        window.__appSettings.wallpaper.parallax = false;
        isParallax = false;
        parallaxToggle.classList.remove('on');
        layer.classList.remove('parallax');
        layer.style.transform = 'none';
        saveAppSettings();
    });

    // ---- parallax ----
    parallaxToggle.addEventListener('click', () => {
        isParallax = !isParallax;
        parallaxToggle.classList.toggle('on', isParallax);
        layer.classList.toggle('parallax', isParallax);
        if (!isParallax) layer.style.transform = 'none';
        window.__appSettings.wallpaper.parallax = isParallax;
        saveAppSettings();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isParallax || !imageUrl) return;
        const x = (e.clientX / window.innerWidth - 0.5) * 16;
        const y = (e.clientY / window.innerHeight - 0.5) * 16;
        layer.style.transform = 'translate(' + x + 'px, ' + y + 'px) scale(1.02)';
    });

    document.addEventListener('touchmove', (e) => {
        if (!isParallax || !imageUrl) return;
        const touch = e.touches[0];
        if (!touch) return;
        const x = (touch.clientX / window.innerWidth - 0.5) * 16;
        const y = (touch.clientY / window.innerHeight - 0.5) * 16;
        layer.style.transform = 'translate(' + x + 'px, ' + y + 'px) scale(1.02)';
    }, { passive: true });

    // ---- weather ----
    async function fetchTemperature() {
        try {
            const res = await fetch(
                'https://api.open-meteo.com/v1/forecast?latitude=13.3347&longitude=74.7462&current_weather=true&timezone=auto'
            );
            if (!res.ok) throw new Error('Weather API error');
            const data = await res.json();
            if (data.current_weather) {
                const temp = Math.round(data.current_weather.temperature);
                tempDisplay.textContent = temp;
                const code = data.current_weather.weathercode || 0;
                const iconMap = {
                    0: 'fa-sun',
                    1: 'fa-cloud-sun',
                    2: 'fa-cloud-sun',
                    3: 'fa-cloud',
                    45: 'fa-smog',
                    48: 'fa-smog',
                    51: 'fa-cloud-rain',
                    53: 'fa-cloud-rain',
                    55: 'fa-cloud-rain',
                    61: 'fa-cloud-showers-heavy',
                    63: 'fa-cloud-showers-heavy',
                    65: 'fa-cloud-showers-heavy',
                    71: 'fa-snowflake',
                    73: 'fa-snowflake',
                    75: 'fa-snowflake',
                    80: 'fa-cloud-rain',
                    81: 'fa-cloud-rain',
                    82: 'fa-cloud-rain',
                    95: 'fa-bolt',
                    96: 'fa-bolt',
                    99: 'fa-bolt'
                };
                const icon = iconMap[code] || 'fa-cloud-sun';
                weatherIcon.className = 'fas ' + icon;
            }
        } catch (e) {
            console.warn('Weather fetch failed:', e);
        }
    }

    fetchTemperature();
    setInterval(fetchTemperature, 60000);

    console.log('Wallpaper + weather ready');
})();


// ============================================================
//  5. QUICK LINKS – with localStorage
// ============================================================
(function quickLinks() {
    'use strict';

    const dockItems = document.getElementById('dockItems');
    const editorContainer = document.getElementById('quicklinksEditor');
    const addBtn = document.getElementById('addQuicklinkBtn');

    const STORAGE_KEY = 'quicklinks_data';
    let links = [];

    const defaultLinks = [
        { name: 'GitHub', url: 'https://github.com', icon: 'fab fa-github' },
        { name: 'Hacker News', url: 'https://news.ycombinator.com', icon: 'fab fa-hacker-news' },
        { name: 'Reddit', url: 'https://www.reddit.com', icon: 'fab fa-reddit-alien' },
        { name: 'Wikipedia', url: 'https://www.wikipedia.org', icon: 'fab fa-wikipedia-w' },
        { name: 'YouTube', url: 'https://www.youtube.com', icon: 'fab fa-youtube' },
        { name: 'Twitter', url: 'https://www.twitter.com', icon: 'fab fa-twitter' }
    ];

    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed) && parsed.length > 0) {
                links = parsed;
            } else {
                links = JSON.parse(JSON.stringify(defaultLinks));
            }
        } else {
            links = JSON.parse(JSON.stringify(defaultLinks));
        }
    } catch (e) {
        links = JSON.parse(JSON.stringify(defaultLinks));
    }

    function saveLinks() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(links));
        } catch (e) {}
    }

    function renderDock() {
        dockItems.innerHTML = '';
        links.forEach((link) => {
            const a = document.createElement('a');
            a.href = link.url;
            a.target = '_blank';
            a.className = 'item';
            a.dataset.tooltip = link.name;
            if (link.icon && link.icon.includes('fa-')) {
                a.innerHTML = '<i class="' + link.icon + '"></i>';
            } else if (link.icon) {
                a.innerHTML = '<img class="icon-img" src="' + link.icon + '" alt="' + link.name + '" />';
            } else {
                a.innerHTML = '<i class="fas fa-link"></i>';
            }
            dockItems.appendChild(a);
        });
    }

    function renderEditor() {
        editorContainer.innerHTML = '';
        links.forEach((link, i) => {
            const row = document.createElement('div');
            row.className = 'quicklink-row';
            const preview = document.createElement('div');
            preview.className = 'ql-preview';
            if (link.icon && link.icon.includes('fa-')) {
                preview.innerHTML = '<i class="' + link.icon + '"></i>';
            } else if (link.icon) {
                preview.innerHTML = '<img src="' + link.icon + '" alt="" />';
            } else {
                preview.innerHTML = '<i class="fas fa-link"></i>';
            }
            row.appendChild(preview);

            const nameInput = document.createElement('input');
            nameInput.className = 'ql-input';
            nameInput.placeholder = 'Name';
            nameInput.value = link.name;
            nameInput.addEventListener('input', () => {
                link.name = nameInput.value;
                saveLinks();
                renderDock();
            });
            row.appendChild(nameInput);

            const urlInput = document.createElement('input');
            urlInput.className = 'ql-input';
            urlInput.placeholder = 'URL';
            urlInput.value = link.url;
            urlInput.addEventListener('input', () => {
                link.url = urlInput.value;
                saveLinks();
                renderDock();
            });
            row.appendChild(urlInput);

            const iconInput = document.createElement('input');
            iconInput.className = 'ql-input icon-input';
            iconInput.placeholder = 'Icon (FA or URL)';
            iconInput.value = link.icon || '';
            iconInput.addEventListener('input', () => {
                link.icon = iconInput.value;
                saveLinks();
                renderDock();
                renderEditor();
            });
            row.appendChild(iconInput);

            const removeBtn = document.createElement('span');
            removeBtn.className = 'ql-remove';
            removeBtn.innerHTML = '<i class="fas fa-times"></i>';
            removeBtn.addEventListener('click', () => {
                links.splice(i, 1);
                saveLinks();
                renderDock();
                renderEditor();
            });
            row.appendChild(removeBtn);

            editorContainer.appendChild(row);
        });
    }

    addBtn.addEventListener('click', () => {
        links.push({ name: 'New Link', url: 'https://example.com', icon: 'fas fa-link' });
        saveLinks();
        renderDock();
        renderEditor();
    });

    renderDock();
    renderEditor();

    console.log('Quick links ready');
})();


// ============================================================
//  6. SETTINGS – connect UI controls
// ============================================================
(function settings() {
    const randomBtn = document.getElementById('randomSplatsBtn');
    const intensitySlider = document.getElementById('splatIntensity');
    const intensityVal = document.getElementById('splatIntensityVal');
    const radiusSlider = document.getElementById('splatRadius');
    const radiusVal = document.getElementById('splatRadiusVal');

    const savedFluid = window.__appSettings.fluid || { splatIntensity: 8, splatRadius: 0.005 };
    intensitySlider.value = String(savedFluid.splatIntensity || 8);
    intensityVal.textContent = String(savedFluid.splatIntensity || 8);
    radiusSlider.value = String(savedFluid.splatRadius || 0.005);
    radiusVal.textContent = String((savedFluid.splatRadius || 0.005).toFixed(3));
    if (window.__fluid) window.__fluid.setSplatRadius(Number(savedFluid.splatRadius || 0.005));

    randomBtn.addEventListener('click', () => {
        if (window.__ui) window.__ui.triggerRandomSplats();
        else if (window.__fluid) window.__fluid.multipleSplats(8);
    });

    intensitySlider.addEventListener('input', () => {
        const val = parseInt(intensitySlider.value, 10) || 8;
        intensityVal.textContent = String(val);
        window.__appSettings.fluid = window.__appSettings.fluid || {};
        window.__appSettings.fluid.splatIntensity = val;
        saveAppSettings();
    });

    radiusSlider.addEventListener('input', () => {
        const val = parseFloat(radiusSlider.value) || 0.005;
        radiusVal.textContent = val.toFixed(3);
        if (window.__fluid) window.__fluid.setSplatRadius(val);
        window.__appSettings.fluid = window.__appSettings.fluid || {};
        window.__appSettings.fluid.splatRadius = val;
        saveAppSettings();
    });

    window.triggerRandomSplats = () => {
        if (window.__ui) window.__ui.triggerRandomSplats();
        else if (window.__fluid) window.__fluid.multipleSplats(8);
    };

    const pingValue = document.getElementById('pingValue');

    function updatePing() {
        const ping = Math.floor(12 + Math.random() * 88);
        pingValue.textContent = ping;
    }
    updatePing();
    setInterval(updatePing, 5000);

    console.log('Settings connected');
})();


// ============================================================
//  7. DOCK – macOS style magnification
// ============================================================
(function initDock() {
    const dock = document.getElementById('dock');
    if (!dock) return;
    const items = dock.querySelectorAll('.item');
    const baseSize = 46;
    const maxSize = 64;
    const maxDist = 130;
    let rafId = null;
    let mouseX = 0,
        mouseY = 0;
    let isInside = false;
    let centers = [];

    function getCenters() {
        const rect = dock.getBoundingClientRect();
        return Array.from(items).map((el) => {
            const r = el.getBoundingClientRect();
            return { el, cx: r.left + r.width / 2 - rect.left, cy: r.top + r.height / 2 - rect.top };
        });
    }

    centers = getCenters();
    const ro = new ResizeObserver(() => { centers = getCenters(); });
    ro.observe(dock);

    function updateSizes(clientX, clientY) {
        const rect = dock.getBoundingClientRect();
        const dx = clientX - rect.left;
        const dy = clientY - rect.top;
        const scales = centers.map((item) => {
            const dist = Math.hypot(dx - item.cx, dy - item.cy);
            let scale = 1;
            if (dist < maxDist) {
                const t = 1 - (dist / maxDist);
                const eased = 1 - Math.pow(1 - t, 1.5);
                scale = 1 + (maxSize / baseSize - 1) * eased;
            }
            return Math.min(scale, maxSize / baseSize);
        });
        centers.forEach((item, i) => {
            const s = scales[i];
            const newSize = baseSize * s;
            item.el.style.width = newSize + 'px';
            item.el.style.height = newSize + 'px';
            item.el.classList.toggle('magnified', s > 1.05);
            item.el.style.zIndex = Math.round(s * 10);
        });
    }

    function onMove(e) {
        mouseX = e.clientX;
        mouseY = e.clientY;
        if (!isInside) return;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => { updateSizes(mouseX, mouseY);
            rafId = null; });
    }

    function onEnter() { isInside = true; }

    function onLeave() {
        isInside = false;
        items.forEach((el) => {
            el.style.width = baseSize + 'px';
            el.style.height = baseSize + 'px';
            el.classList.remove('magnified');
            el.style.zIndex = 1;
        });
        if (rafId) { cancelAnimationFrame(rafId);
            rafId = null; }
    }

    dock.addEventListener('mousemove', onMove);
    dock.addEventListener('mouseenter', onEnter);
    dock.addEventListener('mouseleave', onLeave);

    if ('ontouchstart' in window) {
        dock.removeEventListener('mousemove', onMove);
        dock.removeEventListener('mouseenter', onEnter);
        dock.removeEventListener('mouseleave', onLeave);
        items.forEach((el) => {
            el.style.width = baseSize + 'px';
            el.style.height = baseSize + 'px';
        });
    }
    console.log('Dock ready');
})();

console.log('✅ Glass New Tab — all systems ready');