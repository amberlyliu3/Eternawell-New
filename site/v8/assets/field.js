// Particle field shared by every page.
// Home (several [data-scene] sections): the shape follows scroll.
// Other pages: <body data-shape="0-3" data-side="1|-1"> picks one shape, which fades back as you scroll.
import * as THREE from 'three';

const canvas = document.getElementById('field');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const small = matchMedia('(max-width: 860px)');

if (canvas) {
  try {
    start();
  } catch (err) {
    console.warn('WebGL unavailable, showing static background', err);
    document.documentElement.classList.add('no-gl');
  }
}

function start() {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: 'high-performance' });
  const dpr = Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 50);
  camera.position.set(0, 0, 8);

  // ----- Four target shapes, one point per particle in each -----
  const COUNT = small.matches ? 7000 : 16000;
  const sphere = new Float32Array(COUNT * 3);
  const helix = new Float32Array(COUNT * 3);
  const wave = new Float32Array(COUNT * 3);
  const knot = new Float32Array(COUNT * 3);
  const colors = new Float32Array(COUNT * 3);
  const rand = new Float32Array(COUNT);

  // sRGB 0–1 values; the shader writes them straight to the canvas
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const palette = ['#d8c6a2', '#6b5230', '#e6d6b8', '#8c6d3f', '#b39a6e'].map(hex);

  const v = new THREE.Vector3();
  const xAxis = new THREE.Vector3(1, 0, 0);
  const zAxis = new THREE.Vector3(0, 0, 1);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const jitter = (s) => (Math.random() - 0.5) * s;

  for (let i = 0; i < COUNT; i++) {
    // Whole person: a fibonacci shell with a little interior volume
    const y = 1 - (i / (COUNT - 1)) * 2;
    const rad = Math.sqrt(1 - y * y);
    const th = golden * i;
    const shell = Math.random() < 0.85 ? 1 + jitter(0.06) : Math.cbrt(Math.random());
    v.set(Math.cos(th) * rad, y, Math.sin(th) * rad).multiplyScalar(1.75 * shell);
    v.toArray(sphere, i * 3);

    // Labs: a double helix with rungs, tilted
    if (Math.random() < 0.72) {
      const s = Math.random();
      const a = s * Math.PI * 4.5 + (i % 2) * Math.PI;
      v.set(Math.cos(a) * 0.95, (s - 0.5) * 4.2, Math.sin(a) * 0.95);
    } else {
      const k = Math.floor(Math.random() * 26) / 26;
      const a = k * Math.PI * 4.5;
      const f = Math.random() * 2 - 1;
      v.set(Math.cos(a) * 0.95 * f, (k - 0.5) * 4.2, Math.sin(a) * 0.95 * f);
    }
    v.x += jitter(0.08); v.y += jitter(0.08); v.z += jitter(0.08);
    v.applyAxisAngle(zAxis, 0.42);
    v.toArray(helix, i * 3);

    // Balance: a gently rolling sheet seen at an angle
    const wx = (Math.random() * 2 - 1) * 2.4;
    const wy = (Math.random() * 2 - 1) * 1.5;
    v.set(wx, wy, 0.45 * Math.sin(wx * 1.5 + wy * 0.7) * Math.cos(wy * 1.2));
    v.applyAxisAngle(xAxis, -1.0);
    v.toArray(wave, i * 3);

    // Ongoing care: a (2,3) torus knot, a loop with no end
    const u = Math.random() * Math.PI * 2;
    const r = Math.cos(3 * u) + 2;
    v.set(r * Math.cos(2 * u), r * Math.sin(2 * u), -Math.sin(3 * u)).multiplyScalar(0.62);
    const tube = new THREE.Vector3(jitter(2), jitter(2), jitter(2)).normalize().multiplyScalar(0.16 * Math.cbrt(Math.random()));
    v.add(tube);
    v.toArray(knot, i * 3);

    const c = palette[Math.floor(Math.pow(Math.random(), 1.3) * palette.length)];
    colors[i * 3] = c[0]; colors[i * 3 + 1] = c[1]; colors[i * 3 + 2] = c[2];
    rand[i] = Math.random();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(sphere, 3));
  geo.setAttribute('aHelix', new THREE.BufferAttribute(helix, 3));
  geo.setAttribute('aWave', new THREE.BufferAttribute(wave, 3));
  geo.setAttribute('aKnot', new THREE.BufferAttribute(knot, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aRand', new THREE.BufferAttribute(rand, 1));

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uMorph: { value: 0 },
      uSize: { value: small.matches ? 30 : 26 },
      uPixelRatio: { value: dpr },
      uMouse: { value: new THREE.Vector3(99, 99, 99) },
      uAlpha: { value: 0.9 },
    },
    vertexShader: /* glsl */`
      uniform float uTime;
      uniform float uMorph;
      uniform float uSize;
      uniform float uPixelRatio;
      uniform vec3 uMouse;
      attribute vec3 aHelix;
      attribute vec3 aWave;
      attribute vec3 aKnot;
      attribute vec3 aColor;
      attribute float aRand;
      varying vec3 vColor;
      varying float vFade;
      void main() {
        float m = uMorph;
        vec3 p = position;
        p = mix(p, aHelix, smoothstep(0.0, 1.0, clamp(m, 0.0, 1.0)));
        p = mix(p, aWave, smoothstep(0.0, 1.0, clamp(m - 1.0, 0.0, 1.0)));
        p = mix(p, aKnot, smoothstep(0.0, 1.0, clamp(m - 2.0, 0.0, 1.0)));

        // Calm drift at rest, a swirl while a shape is changing
        float change = sin(3.14159 * fract(m));
        float t = uTime * 0.6 + aRand * 6.2831;
        p += vec3(sin(t + p.y * 1.7), cos(t * 0.9 + p.z * 1.3), sin(t * 1.1 + p.x * 1.5)) * (0.03 + 0.32 * change);

        // Particles part around the cursor
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vec3 away = wp.xyz - uMouse;
        float near = smoothstep(1.3, 0.0, length(away));
        wp.xyz += normalize(away + 1e-4) * near * 0.55;

        vec4 mv = viewMatrix * wp;
        gl_Position = projectionMatrix * mv;
        gl_PointSize = uSize * (0.55 + aRand * 0.9) * uPixelRatio / -mv.z;
        vColor = aColor;
        vFade = 0.35 + 0.65 * smoothstep(11.0, 6.0, -mv.z);
      }`,
    fragmentShader: /* glsl */`
      uniform float uAlpha;
      varying vec3 vColor;
      varying float vFade;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.12, d);
        if (a < 0.01) discard;
        gl_FragColor = vec4(vColor, a * uAlpha * vFade);
      }`,
  });

  const field = new THREE.Points(geo, material);
  field.frustumCulled = false;
  scene.add(field);

  // ----- Scroll → shape and side -----
  const scenes = [...document.querySelectorAll('[data-scene]')];
  const scrollMode = scenes.length > 1;
  const sides = scenes.map((s) => Number(s.dataset.side) || 0);
  const pageShape = Number(document.body.dataset.shape || 0);
  const pageSide = Number(document.body.dataset.side || 1);
  const railLinks = [...document.querySelectorAll('.rail a')];

  function scrollProgress() {
    const mid = window.innerHeight * 0.5;
    const centers = scenes.map((s) => { const r = s.getBoundingClientRect(); return r.top + r.height / 2; });
    if (mid <= centers[0]) return 0;
    for (let i = 0; i < centers.length - 1; i++) {
      if (mid < centers[i + 1]) return i + (mid - centers[i]) / (centers[i + 1] - centers[i]);
    }
    return centers.length - 1;
  }
  function sideAt(p) {
    const i = Math.floor(p), f = p - i;
    const a = sides[i], b = sides[Math.min(i + 1, sides.length - 1)];
    const e = f * f * (3 - 2 * f);
    return a + (b - a) * e;
  }

  // ----- Pointer → world point on the z = 0 plane -----
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  const ndc = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const hit = new THREE.Vector3();
  let mouseActive = false;
  window.addEventListener('pointermove', (e) => {
    pointer.tx = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.ty = (e.clientY / window.innerHeight) * 2 - 1;
    mouseActive = e.pointerType === 'mouse' && !small.matches;
    ndc.set(pointer.tx, -pointer.ty);
  }, { passive: true });
  document.addEventListener('pointerleave', () => { mouseActive = false; });

  function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  let morph = scrollMode ? scrollProgress() : pageShape;
  let activeScene = -1;
  const clock = new THREE.Clock();

  function frame() {
    requestAnimationFrame(frame);
    const t = reduceMotion ? 0 : clock.getElapsedTime();

    const target = scrollMode ? scrollProgress() : pageShape;
    morph += (target - morph) * (reduceMotion ? 0.25 : 0.07);
    material.uniforms.uMorph.value = morph;
    material.uniforms.uTime.value = t;

    // Inner pages: the field steps back once you scroll into the content
    const baseAlpha = small.matches ? 0.5 : 0.9;
    const recede = scrollMode ? 0 : Math.min(window.scrollY / (window.innerHeight * 0.9), 1);
    material.uniforms.uAlpha.value = baseAlpha * (1 - 0.6 * recede);

    pointer.x += (pointer.tx - pointer.x) * 0.05;
    pointer.y += (pointer.ty - pointer.y) * 0.05;

    const halfW = Math.tan(THREE.MathUtils.degToRad(20)) * camera.position.z * camera.aspect;
    const sx = small.matches ? 0 : Math.min(2.5, halfW * 0.5);
    field.position.x = (scrollMode ? sideAt(morph) : pageSide) * sx;
    field.position.y = small.matches ? 0.6 : 0;
    field.scale.setScalar(small.matches ? 0.8 : scrollMode ? 1 : 0.9);
    field.rotation.y = t * 0.07 + pointer.x * 0.2;
    field.rotation.x = pointer.y * 0.12;

    if (mouseActive) {
      raycaster.setFromCamera(ndc, camera);
      if (raycaster.ray.intersectPlane(plane, hit)) material.uniforms.uMouse.value.copy(hit);
    } else {
      material.uniforms.uMouse.value.set(99, 99, 99);
    }

    if (railLinks.length) {
      const idx = Math.round(morph);
      if (idx !== activeScene) {
        activeScene = idx;
        railLinks.forEach((a, i) => a.classList.toggle('on', i === idx));
      }
    }

    renderer.render(scene, camera);
  }
  frame();
}
