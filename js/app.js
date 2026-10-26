// رحلة إلى عالم المد والجزر
// Interactive 3D tides model (Three.js r128) with optional camera
// pass-through and WebXR AR placement. Lesson text lives in lesson.js.

(function () {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const app = $('#app');
  const panel = $('#panel');
  const startScreen = $('#start-screen');

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isPhone = () => app.clientWidth <= 760;

  const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
  const toArabicDigits = (value) => String(value).replace(/[0-9]/g, (d) => ARABIC_DIGITS[d]);

  const clamp = (x, min, max) => Math.min(max, Math.max(min, x));

  function smoothstep(edge0, edge1, x) {
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  // Signed difference between two angles, in (-PI, PI].
  function angleDiff(a, b) {
    let d = (a - b) % (2 * Math.PI);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }

  // Small seeded random generator so rocks and craters look the same on every load.
  function seededRandom(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function setHidden(el, hidden) {
    if (el.hidden !== hidden) el.hidden = hidden;
  }

  function showFatal(message) {
    const box = $('#fatal');
    box.querySelector('p').textContent = message;
    box.hidden = false;
  }

  if (typeof THREE === 'undefined') {
    showFatal('تعذّر تحميل مكتبة الرسوم ثلاثية الأبعاد. تأكد من الاتصال بالإنترنت ثم أعد تحميل الصفحة.');
    return;
  }

  // ---------------------------------------------------------------------
  // Renderer, scene and lights
  // ---------------------------------------------------------------------

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: $('#scene'), antialias: true, alpha: true });
  } catch (err) {
    showFatal('هذا الجهاز أو المتصفح لا يدعم الرسوم ثلاثية الأبعاد (WebGL). جرّب متصفح Chrome أو Edge أو Safari حديثًا.');
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);

  const { Vector3 } = THREE;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 800);

  const world = new THREE.Group();
  const beachModel = new THREE.Group();
  const space = new THREE.Group();
  scene.add(world);
  world.add(beachModel, space);

  const hemiLight = new THREE.HemisphereLight(0xe3f4ff, 0x9c7b4a, 0.95);
  const sunLight = new THREE.DirectionalLight(0xfff1d6, 0.9);
  const ambientLight = new THREE.AmbientLight(0x8fa6d6, 0);
  sunLight.position.set(6, 10, 8);
  scene.add(hemiLight, sunLight, ambientLight);

  const DAY_LIGHTING = { hemi: 0.95, ambient: 0, sun: 0.9, sunPosition: [6, 10, 8] };
  const SPACE_LIGHTING = { hemi: 0.12, ambient: 0.42, sun: 1.25, sunPosition: [-10, 1, 0] };

  function applyLighting(preset) {
    hemiLight.intensity = preset.hemi;
    ambientLight.intensity = preset.ambient;
    sunLight.intensity = preset.sun;
    sunLight.position.fromArray(preset.sunPosition);
  }

  // ---------------------------------------------------------------------
  // Beach model (start screen and the "our beach" frame)
  // ---------------------------------------------------------------------

  const BEACH_WIDTH = 12;
  const BEACH_Z_MIN = -4;
  const BEACH_Z_MAX = 6;
  const TANK_FLOOR = -1.6;

  // Ambient tide shown behind the start screen.
  const TIDE_MEAN = -0.25;
  const TIDE_RANGE = 0.6;
  const TIDE_PERIOD = 745; // minutes, ~12 h 25 min

  const ambientTideLevel = (minutes) =>
    TIDE_MEAN + TIDE_RANGE * Math.cos((2 * Math.PI * minutes) / TIDE_PERIOD);

  function sandHeight(z) {
    const base = z < 3 ? 0.9 - 0.28 * (z + 4) : -1.06 - (z - 3) * 0.13;
    return base + 0.04 * Math.sin(z * 2.1);
  }

  // Where the sand slope reaches a given height (binary search).
  function zAtSandHeight(y) {
    let lo = BEACH_Z_MIN;
    let hi = BEACH_Z_MAX;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (sandHeight(mid) > y) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  const highTideZ = zAtSandHeight(TIDE_MEAN + TIDE_RANGE);
  const lowTideZ = zAtSandHeight(TIDE_MEAN - TIDE_RANGE);

  let waterBody, waterSurface, waterSurfaceBase, sailBoat, fishingBoat;

  function buildSand() {
    const profile = new THREE.Shape();
    profile.moveTo(BEACH_Z_MIN, TANK_FLOOR);
    for (let i = 0; i <= 60; i++) {
      const z = BEACH_Z_MIN + ((BEACH_Z_MAX - BEACH_Z_MIN) * i) / 60;
      profile.lineTo(z, sandHeight(z));
    }
    profile.lineTo(BEACH_Z_MAX, TANK_FLOOR);
    profile.lineTo(BEACH_Z_MIN, TANK_FLOOR);

    const geometry = new THREE.ExtrudeGeometry(profile, { depth: BEACH_WIDTH, bevelEnabled: false });
    geometry.rotateY(-Math.PI / 2);
    geometry.translate(BEACH_WIDTH / 2, 0, 0);

    // Colour by height: wet sand low down, dry sand higher up.
    const positions = geometry.attributes.position;
    const colors = new Float32Array(positions.count * 3);
    const dry = new THREE.Color(0xf3dca6);
    const wet = new THREE.Color(0xcfa66b);
    const submerged = new THREE.Color(0xa58657);
    const c = new THREE.Color();
    for (let i = 0; i < positions.count; i++) {
      const y = positions.getY(i);
      c.copy(submerged).lerp(wet, smoothstep(-0.98, -0.72, y)).lerp(dry, smoothstep(0.22, 0.46, y));
      c.toArray(colors, i * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    beachModel.add(new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true })));
  }

  function buildTank() {
    const depth = BEACH_Z_MAX - BEACH_Z_MIN;
    const midZ = (BEACH_Z_MIN + BEACH_Z_MAX) / 2;
    const height = 1.5 - TANK_FLOOR;

    const base = new THREE.Mesh(
      new THREE.BoxGeometry(BEACH_WIDTH + 0.5, 0.5, depth + 0.5),
      new THREE.MeshLambertMaterial({ color: 0x5d7288 })
    );
    base.position.set(0, TANK_FLOOR - 0.25, midZ);

    waterBody = new THREE.Mesh(
      new THREE.BoxGeometry(BEACH_WIDTH - 0.02, 1, depth - 0.02).translate(0, 0.5, 0),
      new THREE.MeshPhongMaterial({ color: 0x1f7fd0, transparent: true, opacity: 0.5, shininess: 80, depthWrite: false })
    );
    waterBody.position.set(0, TANK_FLOOR, midZ);
    waterBody.renderOrder = 1;

    const surfaceGeometry = new THREE.PlaneGeometry(BEACH_WIDTH - 0.02, depth - 0.02, 48, 40);
    surfaceGeometry.rotateX(-Math.PI / 2);
    waterSurfaceBase = surfaceGeometry.attributes.position.array.slice();
    waterSurface = new THREE.Mesh(
      surfaceGeometry,
      new THREE.MeshPhongMaterial({
        color: 0x56bdfb,
        transparent: true,
        opacity: 0.78,
        shininess: 110,
        specular: 0xffffff,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    waterSurface.position.set(0, 0, midZ);
    waterSurface.renderOrder = 2;

    const glass = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(BEACH_WIDTH, height, depth)),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 })
    );
    glass.position.set(0, TANK_FLOOR + height / 2, midZ);

    beachModel.add(base, waterBody, waterSurface, glass);
  }

  function buildTideMarks() {
    [[highTideZ, 0x8fe3ff], [lowTideZ, 0xff8a7a]].forEach(([z, color]) => {
      const mark = new THREE.Mesh(
        new THREE.BoxGeometry(BEACH_WIDTH - 0.1, 0.03, 0.1),
        new THREE.MeshBasicMaterial({ color })
      );
      mark.position.set(0, sandHeight(z) + 0.02, z);
      beachModel.add(mark);
    });
  }

  function buildRocks() {
    const random = seededRandom(7);
    const material = new THREE.MeshLambertMaterial({ color: 0x7d8b99, flatShading: true });
    for (let i = 0; i < 7; i++) {
      const size = 0.22 + random() * 0.28;
      const x = 1.6 + random() * 3.4;
      const z = -0.2 + random() * 1.4;
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(size, 0), material);
      rock.position.set(x, sandHeight(z) + size * 0.15, z);
      rock.rotation.set(random() * 3, random() * 3, 0);
      rock.scale.y = 0.7;
      beachModel.add(rock);
    }
  }

  function buildStarfish() {
    const shape = new THREE.Shape();
    for (let i = 0; i < 10; i++) {
      const angle = (i / 10) * Math.PI * 2;
      const radius = i % 2 ? 0.09 : 0.24;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
    const star = new THREE.Mesh(
      new THREE.ShapeGeometry(shape),
      new THREE.MeshLambertMaterial({ color: 0xff8a5b, side: THREE.DoubleSide })
    );
    star.rotation.x = -Math.PI / 2;
    star.position.set(-1.4, sandHeight(0.5) + 0.03, 0.5);
    beachModel.add(star);
  }

  function buildPalm() {
    const palm = new THREE.Group();
    const trunkMaterial = new THREE.MeshLambertMaterial({ color: 0x8a5a2b });
    const leafMaterial = new THREE.MeshLambertMaterial({ color: 0x3fae5a });

    for (let i = 0; i < 6; i++) {
      const segment = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.42, 8), trunkMaterial);
      segment.position.set(i * i * 0.012, 0.2 + i * 0.38, 0);
      segment.rotation.z = -i * 0.04;
      palm.add(segment);
    }
    for (let i = 0; i < 7; i++) {
      const angle = (i / 7) * Math.PI * 2;
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.55, 10, 6), leafMaterial);
      leaf.scale.set(1, 0.1, 0.28);
      leaf.position.set(0.3 + Math.cos(angle) * 0.45, 2.35, Math.sin(angle) * 0.45);
      leaf.rotation.set(0, -angle, -0.35);
      palm.add(leaf);
    }
    palm.position.set(-4.3, sandHeight(-3.2), -3.2);
    beachModel.add(palm);
  }

  function buildTideGauge() {
    const gauge = new THREE.Group();
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 2.4, 10),
      new THREE.MeshLambertMaterial({ color: 0xffffff })
    );
    pole.position.y = 1.2;
    gauge.add(pole);

    for (let i = 0; i < 9; i++) {
      const band = new THREE.Mesh(
        new THREE.CylinderGeometry(0.068, 0.068, 0.12, 10),
        new THREE.MeshLambertMaterial({ color: i % 2 ? 0x2f6fd1 : 0xe8604c })
      );
      band.position.y = 0.15 + i * 0.26;
      gauge.add(band);
    }

    const flag = new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 0.4, 3),
      new THREE.MeshLambertMaterial({ color: 0xffc83d })
    );
    flag.rotation.z = Math.PI / 2;
    flag.position.set(-0.2, 2.3, 0);
    gauge.add(flag);

    gauge.position.set(4.6, -1.3, 1.9);
    beachModel.add(gauge);
  }

  function makeBoat(hullColor, withWhiteSail) {
    const boat = new THREE.Group();

    const hullGeometry = new THREE.CylinderGeometry(0.3, 0.3, 1.3, 14, 1, false, 0, Math.PI);
    hullGeometry.rotateZ(-Math.PI / 2);
    boat.add(new THREE.Mesh(hullGeometry, new THREE.MeshLambertMaterial({ color: hullColor, side: THREE.DoubleSide })));

    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 1.1, 6),
      new THREE.MeshLambertMaterial({ color: 0x5b3a1e })
    );
    mast.position.y = 0.5;
    boat.add(mast);

    const sailShape = new THREE.Shape();
    sailShape.moveTo(0, 0);
    sailShape.lineTo(0, 0.85);
    sailShape.lineTo(withWhiteSail ? 0.6 : -0.55, 0.05);
    sailShape.lineTo(0, 0);
    const sail = new THREE.Mesh(
      new THREE.ShapeGeometry(sailShape),
      new THREE.MeshLambertMaterial({ color: withWhiteSail ? 0xffffff : 0xf2e6c9, side: THREE.DoubleSide })
    );
    sail.position.set(0.03, 0.12, 0);
    boat.add(sail);

    return boat;
  }

  buildSand();
  buildTank();
  buildTideMarks();
  buildRocks();
  buildStarfish();
  buildPalm();
  buildTideGauge();

  sailBoat = makeBoat(0xe8604c, true);
  sailBoat.position.set(-3.2, 0, 4.6);
  sailBoat.rotation.y = 0.4;

  // This boat rests on the sand at low tide.
  fishingBoat = makeBoat(0xb7773c, false);
  fishingBoat.position.set(1.0, 0, 1.5);
  fishingBoat.rotation.y = -0.3;

  beachModel.add(sailBoat, fishingBoat);

  // ---------------------------------------------------------------------
  // Earth, Moon and Sun (not to scale)
  // ---------------------------------------------------------------------

  const EARTH_RADIUS = 1.6;
  const OCEAN_RADIUS = 1.68;
  const MOON_ORBIT = 6;
  const SUN_ANGLE = Math.PI; // the Sun sits along -x
  const SUN_DISTANCE = 15;
  const MOON_TIDE = 0.3; // bulge height from the Moon (exaggerated)
  const SUN_TIDE = MOON_TIDE * 0.46; // the Sun's effect is about half the Moon's

  // Simplified continent outlines [longitude, latitude] for the Earth texture.
  const CONTINENTS = [
    [[-17, 21], [-16, 28], [-10, 30], [-6, 36], [10, 37], [11, 33], [20, 31], [32, 31], [34, 28], [43, 12], [51, 12], [42, -1], [40, -11], [35, -24], [32, -28], [20, -35], [18, -29], [12, -17], [13, -6], [9, 4], [4, 6], [-8, 4], [-13, 8], [-17, 15]],
    [[-10, 36], [-9, 43], [-2, 44], [-5, 48], [0, 50], [4, 52], [8, 54], [10, 57], [5, 62], [14, 68], [25, 71], [31, 70], [40, 66], [44, 68], [60, 69], [60, 55], [50, 46], [40, 42], [30, 41], [26, 40], [23, 37], [20, 40], [13, 45], [16, 41], [12, 38], [8, 44], [3, 43], [-2, 37]],
    [[40, 42], [50, 46], [60, 55], [60, 69], [70, 73], [80, 73], [100, 78], [110, 77], [140, 73], [160, 70], [180, 68], [180, 64], [170, 60], [160, 58], [156, 51], [142, 46], [135, 43], [130, 35], [122, 40], [121, 31], [117, 24], [108, 21], [106, 10], [100, 13], [103, 1], [98, 8], [94, 17], [90, 22], [80, 15], [78, 8], [73, 20], [66, 25], [57, 26], [56, 24], [59, 22], [52, 16], [43, 13], [39, 21], [35, 28], [35, 33], [36, 36], [30, 37], [27, 40]],
    [[95, 5], [105, -6], [115, -8], [120, -9], [130, -8], [140, -9], [141, -2], [131, -1], [119, 5], [117, 7], [109, 2], [103, -1]],
    [[114, -22], [114, -34], [118, -35], [129, -32], [138, -35], [147, -38], [150, -37], [153, -28], [153, -25], [145, -15], [142, -11], [136, -12], [130, -12], [123, -17]],
    [[-168, 66], [-162, 70], [-140, 70], [-125, 70], [-95, 72], [-80, 73], [-65, 62], [-55, 52], [-66, 45], [-70, 42], [-76, 35], [-81, 31], [-80, 25], [-83, 29], [-90, 30], [-97, 28], [-97, 22], [-87, 21], [-88, 16], [-83, 10], [-79, 8], [-86, 12], [-92, 15], [-105, 20], [-110, 24], [-112, 31], [-117, 32], [-124, 40], [-124, 48], [-133, 56], [-150, 60], [-165, 60]],
    [[-55, 60], [-43, 60], [-20, 70], [-20, 80], [-40, 83], [-60, 82], [-70, 77], [-55, 70]],
    [[-79, 8], [-77, 1], [-81, -5], [-76, -14], [-71, -18], [-71, -30], [-74, -42], [-75, -52], [-68, -55], [-65, -55], [-68, -50], [-65, -42], [-58, -38], [-53, -34], [-48, -26], [-40, -22], [-35, -8], [-35, -5], [-50, 0], [-52, 4], [-60, 8], [-72, 12]],
    [[-5, 50], [1, 51], [2, 53], [-3, 56], [-3, 58.5], [-6, 58], [-5, 55], [-3, 54], [-4.5, 52]],
    [[130, 31], [135, 34], [140, 35], [142, 40], [141, 45], [139, 42], [136, 37], [131, 34]],
    [[44, -25], [47, -25], [50, -15], [49, -12], [44, -17]],
  ];

  const DESERTS = [
    [[-16, 28], [30, 30], [32, 20], [15, 15], [-15, 17]],
    [[36, 30], [47, 30], [56, 24], [52, 17], [43, 14], [38, 20]],
    [[117, -22], [140, -22], [140, -30], [120, -30]],
  ];

  function createEarthTexture() {
    const width = 2048;
    const height = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    const ocean = ctx.createLinearGradient(0, 0, 0, height);
    ocean.addColorStop(0, '#2b7fd2');
    ocean.addColorStop(0.5, '#1d68c0');
    ocean.addColorStop(1, '#2b7fd2');
    ctx.fillStyle = ocean;
    ctx.fillRect(0, 0, width, height);

    const project = (lon, lat) => [((lon + 180) / 360) * width, ((90 - lat) / 180) * height];
    const toPath = (polygons) => {
      const path = new Path2D();
      polygons.forEach((polygon) => {
        polygon.forEach(([lon, lat], i) => {
          const [x, y] = project(lon, lat);
          if (i === 0) path.moveTo(x, y);
          else path.lineTo(x, y);
        });
        path.closePath();
      });
      return path;
    };

    const land = toPath(CONTINENTS);
    land.rect(0, project(0, -70)[1], width, height); // Antarctica
    ctx.fillStyle = '#5fb46a';
    ctx.fill(land);
    ctx.lineJoin = 'round';
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#3b8a4b';
    ctx.stroke(land);

    ctx.save();
    ctx.clip(land);
    ctx.fillStyle = '#d9c27c';
    ctx.fill(toPath(DESERTS));
    ctx.fillStyle = '#f2f7fb';
    ctx.fillRect(0, 0, width, project(0, 72)[1]);
    ctx.fillRect(0, project(0, -66)[1], width, height);
    ctx.restore();

    const texture = new THREE.CanvasTexture(canvas);
    texture.anisotropy = 4;
    return texture;
  }

  function createMoonTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#c9d0da';
    ctx.fillRect(0, 0, 512, 256);

    const random = seededRandom(3);
    for (let i = 0; i < 70; i++) {
      ctx.fillStyle = random() < 0.5 ? 'rgba(120,130,145,.55)' : 'rgba(235,240,246,.5)';
      ctx.beginPath();
      ctx.arc(random() * 512, random() * 256, 3 + random() * 18, 0, Math.PI * 2);
      ctx.fill();
    }
    return new THREE.CanvasTexture(canvas);
  }

  function createGlowTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const glow = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    glow.addColorStop(0, 'rgba(255,220,120,1)');
    glow.addColorStop(0.3, 'rgba(255,190,60,.55)');
    glow.addColorStop(1, 'rgba(255,170,40,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 256, 256);
    return new THREE.CanvasTexture(canvas);
  }

  function lonLatToVector(lon, lat) {
    const phi = ((lon + 180) * Math.PI) / 180;
    const theta = ((90 - lat) * Math.PI) / 180;
    return new Vector3(
      -Math.cos(phi) * Math.sin(theta),
      Math.cos(theta),
      Math.sin(phi) * Math.sin(theta)
    );
  }

  // Point on the orbit plane at a given angle (counter-clockwise seen from above).
  function onOrbitPlane(angle, radius, target, y = 0) {
    return target.set(Math.cos(angle) * radius, y, -Math.sin(angle) * radius);
  }

  const earthSpin = new THREE.Group();
  space.add(earthSpin);

  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_RADIUS, 64, 48),
    new THREE.MeshPhongMaterial({ map: createEarthTexture(), shininess: 12 })
  );
  earthSpin.add(earth);

  // Red pin marking Bahrain ("our beach").
  const bahrainDirection = lonLatToVector(50.55, 26.0).normalize();
  const pin = new THREE.Group();
  const pinStick = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.022, 0.42, 6),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  );
  pinStick.position.y = 0.21;
  const pinHead = new THREE.Mesh(
    new THREE.SphereGeometry(0.08, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xff4d4d })
  );
  pinHead.position.y = 0.44;
  pin.add(pinStick, pinHead);
  pin.position.copy(bahrainDirection).multiplyScalar(EARTH_RADIUS);
  pin.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), bahrainDirection);
  earth.add(pin);

  // Ocean shell that is stretched into tidal bulges every frame.
  const oceanGeometry = new THREE.SphereGeometry(1, 96, 64);
  const oceanDirections = oceanGeometry.attributes.position.array.slice();
  const oceanColors = new Float32Array(oceanDirections.length);
  oceanGeometry.setAttribute('color', new THREE.BufferAttribute(oceanColors, 3));
  const ocean = new THREE.Mesh(
    oceanGeometry,
    new THREE.MeshPhongMaterial({ vertexColors: true, transparent: true, opacity: 0.55, shininess: 90, depthWrite: false })
  );
  ocean.renderOrder = 3;
  space.add(ocean);

  // Tidal height for a direction on the orbit plane: each body raises two
  // opposite bulges (second Legendre polynomial of the angle to that body).
  function tideHeight(cosToMoon, cosToSun, moonTide, sunTide) {
    return moonTide * (1.5 * cosToMoon * cosToMoon - 0.5) + sunTide * (1.5 * cosToSun * cosToSun - 0.5);
  }

  const lowWaterColor = new THREE.Color(0x1b5fbf);
  const highWaterColor = new THREE.Color(0x9ff0ff);
  const waterColor = new THREE.Color();

  function updateOcean(moonTide, sunTide, moonAngle) {
    const moonX = Math.cos(moonAngle);
    const moonZ = -Math.sin(moonAngle);
    const sunX = Math.cos(SUN_ANGLE);
    const sunZ = -Math.sin(SUN_ANGLE);
    const positions = oceanGeometry.attributes.position.array;

    for (let i = 0; i < oceanDirections.length; i += 3) {
      const x = oceanDirections[i];
      const y = oceanDirections[i + 1];
      const z = oceanDirections[i + 2];
      const height = tideHeight(x * moonX + z * moonZ, x * sunX + z * sunZ, moonTide, sunTide);
      const radius = OCEAN_RADIUS + height;

      positions[i] = x * radius;
      positions[i + 1] = y * radius;
      positions[i + 2] = z * radius;

      waterColor.copy(lowWaterColor).lerp(highWaterColor, clamp((height + 0.21) / 0.62, 0, 1));
      waterColor.toArray(oceanColors, i);
    }
    oceanGeometry.attributes.position.needsUpdate = true;
    oceanGeometry.attributes.color.needsUpdate = true;
  }

  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(0.45, 32, 24),
    new THREE.MeshPhongMaterial({ map: createMoonTexture(), emissive: 0x2a2f3a, shininess: 4 })
  );
  space.add(moon);

  const orbitPoints = [];
  for (let i = 0; i <= 128; i++) {
    orbitPoints.push(onOrbitPlane((i / 128) * Math.PI * 2, MOON_ORBIT, new Vector3()));
  }
  const orbitLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(orbitPoints),
    new THREE.LineDashedMaterial({ color: 0xcfd8e6, dashSize: 0.3, gapSize: 0.22, transparent: true, opacity: 0.5 })
  );
  orbitLine.computeLineDistances();
  space.add(orbitLine);

  const sun = new THREE.Group();
  sun.position.set(-SUN_DISTANCE, 0, 0);
  sun.add(new THREE.Mesh(new THREE.SphereGeometry(2.2, 48, 32), new THREE.MeshBasicMaterial({ color: 0xffcf4a })));
  const sunGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: createGlowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })
  );
  sunGlow.scale.set(10, 10, 1);
  sun.add(sunGlow);
  space.add(sun);

  const stars = (() => {
    const count = 1400;
    const positions = new Float32Array(count * 3);
    const random = seededRandom(11);
    for (let i = 0; i < count; i++) {
      const u = random() * 2 - 1;
      const theta = random() * Math.PI * 2;
      const radius = 140 + random() * 60;
      const ring = Math.sqrt(1 - u * u);
      positions[i * 3] = Math.cos(theta) * ring * radius;
      positions[i * 3 + 1] = u * radius;
      positions[i * 3 + 2] = Math.sin(theta) * ring * radius;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0xdfe9ff, size: 0.7, transparent: true, opacity: 0.85 }));
  })();
  scene.add(stars);

  // ---------------------------------------------------------------------
  // Force arrows and Moon phase markers
  // ---------------------------------------------------------------------

  function makeArrow(length, color, origin, direction) {
    const arrow = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({ color });
    const headLength = Math.min(0.32, length * 0.45);

    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, length - headLength, 10).rotateZ(-Math.PI / 2), material);
    shaft.position.x = (length - headLength) / 2;
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.15, headLength, 14).rotateZ(-Math.PI / 2), material);
    head.position.x = length - headLength / 2;
    arrow.add(shaft, head);

    arrow.position.copy(origin);
    arrow.quaternion.setFromUnitVectors(new Vector3(1, 0, 0), direction.clone().normalize());
    return arrow;
  }

  // Stage 1: the Moon's pull on the near side, centre and far side of the Earth,
  // then the stretch that produces two bulges. Rotates with the Moon.
  const GRAVITY_ROW_Y = 2.6;
  const gravityArrows = new THREE.Group();
  const pullArrows = new THREE.Group();
  const stretchArrows = new THREE.Group();
  gravityArrows.add(pullArrows, stretchArrows);
  space.add(gravityArrows);

  [[1.7, 1.55], [0, 1.05], [-1.7, 0.62]].forEach(([x, length]) => {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    dot.position.set(x, GRAVITY_ROW_Y, 0);
    pullArrows.add(dot);
    pullArrows.add(makeArrow(length, 0xffb703, new Vector3(x + 0.12, GRAVITY_ROW_Y, 0), new Vector3(1, 0, 0)));

    const surfaceY = Math.sqrt(Math.max(0, EARTH_RADIUS * EARTH_RADIUS - x * x));
    const guide = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new Vector3(x, GRAVITY_ROW_Y - 0.12, 0), new Vector3(x, surfaceY + 0.02, 0)]),
      new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.08, gapSize: 0.08, transparent: true, opacity: 0.7 })
    );
    guide.computeLineDistances();
    pullArrows.add(guide);
  });

  stretchArrows.add(
    makeArrow(0.85, 0x8fe3ff, new Vector3(2.05, 0, 0), new Vector3(1, 0, 0)),
    makeArrow(0.85, 0x8fe3ff, new Vector3(-2.05, 0, 0), new Vector3(-1, 0, 0)),
    makeArrow(0.5, 0xff8a7a, new Vector3(0, 0, 2.25), new Vector3(0, 0, -1)),
    makeArrow(0.5, 0xff8a7a, new Vector3(0, 0, -2.25), new Vector3(0, 0, 1))
  );

  // Stages 2 and 3: two-sided arrows for the Moon's and the Sun's tidal effect.
  const moonEffect = new THREE.Group();
  const sunEffect = new THREE.Group();
  moonEffect.add(
    makeArrow(1.5, 0xcfd8e6, new Vector3(2.2, 0.1, 0), new Vector3(1, 0, 0)),
    makeArrow(1.5, 0xcfd8e6, new Vector3(-2.2, 0.1, 0), new Vector3(-1, 0, 0))
  );
  sunEffect.add(
    makeArrow(0.8, 0xffc83d, new Vector3(2.2, -0.1, 0), new Vector3(1, 0, 0)),
    makeArrow(0.8, 0xffc83d, new Vector3(-2.2, -0.1, 0), new Vector3(-1, 0, 0))
  );
  sunEffect.rotation.y = SUN_ANGLE;
  space.add(moonEffect, sunEffect);

  // Moon angle for each phase, measured with the Sun at SUN_ANGLE.
  const PHASES = {
    new: Math.PI,
    full: 0,
    firstQuarter: (3 * Math.PI) / 2,
    lastQuarter: Math.PI / 2,
  };

  const phaseMarkers = new THREE.Group();
  Object.values(PHASES).forEach((angle) => {
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.32, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0xcfd8e6, transparent: true, opacity: 0.22, depthWrite: false })
    );
    onOrbitPlane(angle, MOON_ORBIT, marker.position);
    phaseMarkers.add(marker);
  });
  space.add(phaseMarkers);

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------

  const newInquiry = () => ({ prediction: null, solved: false, wrongAnswers: {} });

  function createState(previous) {
    return {
      stage: 0,
      completed: [false, false, false],
      sceneName: 'beach',
      tideClock: 0,

      earthSpinning: true,
      moonAngle: 0.75,
      moonTarget: null,
      draggingMoon: false,
      moonWasDragged: false,
      dragDistance: 0,

      gravityStep: 0,
      gravityStepMax: 0,
      moonTide: MOON_TIDE,
      sunTide: 0,
      sunTideTarget: 0,
      effectsVisible: false,
      effectsSeen: {},
      visitedPhases: {},

      inquiry: { 1: newInquiry(), 2: newInquiry(), 3: newInquiry() },

      // Water at the Bahrain pin.
      beach: {
        height: 0,
        relative: 0.5,
        rising: true,
        previous: null,
        previousDelta: 0,
        highs: 0,
        lows: 0,
        turned: 0,
        lastHighs: null,
        lastLows: null,
      },

      sound: previous ? previous.sound : true,
      showBeach: previous ? previous.showBeach : true,
    };
  }

  let state = createState();

  const taskChecks = {
    draggedHalfOrbit: () => state.dragDistance >= Math.PI,
    sawGravityArrows: () => state.gravityStepMax >= 1,
    sawWaterBulges: () => state.gravityStepMax >= 2,
    watchedFullRotation: () => state.beach.lastHighs !== null,
    visitedNew: () => !!state.visitedPhases.new,
    visitedFull: () => !!state.visitedPhases.full,
    visitedFirstQuarter: () => !!state.visitedPhases.firstQuarter,
    visitedLastQuarter: () => !!state.visitedPhases.lastQuarter,
    sawEffects: () => !!state.effectsSeen[state.stage],
  };

  const isTaskDone = (task) => taskChecks[task.check]();

  // ---------------------------------------------------------------------
  // Floating labels
  // ---------------------------------------------------------------------

  const labelLayer = $('#labels');
  const labels = [];
  const tmpVector = new Vector3();
  const tmpCenter = new Vector3();
  const ORIGIN = (target) => target.set(0, 0, 0);

  const inSpace = () => state.sceneName !== 'beach';
  const inBeachScene = () => state.sceneName === 'beach';
  const inSunScene = () => state.sceneName === 'sun';
  const inMoonScene = () => state.sceneName === 'moon';

  // anchor:  world position of the label
  // center:  object the label describes; the label is pushed outward from it
  // facing:  surface normal; the label hides when it faces away from the camera
  function addLabel({ text, type, anchor, visible, center = null, facing = null, priority = 1 }) {
    const el = document.createElement('div');
    el.className = 'label ' + type.split(' ').map((t) => 'label--' + t).join(' ');
    el.textContent = typeof text === 'function' ? text() : text;
    el.style.display = 'none';
    labelLayer.appendChild(el);

    const label = { el, text, anchor, visible, center, facing, priority, shown: false, width: null, height: 0, measuredText: '' };
    labels.push(label);
    return label;
  }

  function moonPosition(target) {
    return onOrbitPlane(state.moonAngle, MOON_ORBIT, target);
  }

  // Direction of the combined tidal bulge (Moon + Sun).
  function combinedTide() {
    const re = state.moonTide * Math.cos(2 * state.moonAngle) + state.sunTide * Math.cos(2 * SUN_ANGLE);
    const im = state.moonTide * Math.sin(2 * state.moonAngle) + state.sunTide * Math.sin(2 * SUN_ANGLE);
    return { range: Math.hypot(re, im), angle: Math.atan2(im, re) / 2 };
  }

  function bulgeLabelText() {
    if (!inSunScene()) return 'مدّ';
    const alignment = Math.cos(2 * angleDiff(state.moonAngle, SUN_ANGLE));
    if (alignment > 0.85) return 'مدّ عالٍ';
    if (alignment < -0.85) return 'مدّ منخفض';
    return 'مدّ';
  }

  // Beach scene
  addLabel({ text: 'الشاطئ', type: 'earth', anchor: (v) => v.set(-1.5, sandHeight(-2.6) + 0.5, -2.6), visible: inBeachScene });
  addLabel({ text: 'البحر', type: 'high', anchor: (v) => v.set(-0.5, ambientTideLevel(state.tideClock) + 0.45, 5.2), visible: inBeachScene });
  addLabel({ text: 'أعلى مد', type: 'high', anchor: (v) => v.set(-4.6, sandHeight(highTideZ) + 0.32, highTideZ), visible: inBeachScene });
  addLabel({ text: 'أدنى جزر', type: 'low', anchor: (v) => v.set(-4.6, sandHeight(lowTideZ) + 0.32, lowTideZ), visible: inBeachScene });
  addLabel({ text: 'مقياس الماء', type: 'sun', anchor: (v) => v.set(4.6, 1.45, 1.9), visible: inBeachScene });

  // Space scenes
  addLabel({ text: 'الأرض', type: 'earth large', anchor: (v) => v.set(0, -1.75, 0), center: ORIGIN, visible: inSpace, priority: 0 });

  const moonLabel = addLabel({
    text: 'القمر',
    type: 'moon large',
    anchor: (v) => moonPosition(v).setY(0.5),
    center: moonPosition,
    visible: inSpace,
    priority: 3,
  });

  addLabel({
    text: 'الشمس',
    type: 'sun large',
    anchor: (v) => v.set(-SUN_DISTANCE, 2.3, 0),
    center: (v) => v.set(-SUN_DISTANCE, 0, 0),
    visible: inSunScene,
  });

  [0, 1].forEach((side) => {
    addLabel({
      text: bulgeLabelText,
      type: 'high',
      anchor: (v) => onOrbitPlane(combinedTide().angle + side * Math.PI, 2.25, v),
      center: ORIGIN,
      visible: inSpace,
    });
    addLabel({
      text: 'جزر',
      type: 'low',
      anchor: (v) => onOrbitPlane(combinedTide().angle + Math.PI / 2 + side * Math.PI, 1.85, v),
      center: ORIGIN,
      visible: inSpace,
    });
  });

  addLabel({
    text: 'شاطئنا',
    type: 'pin',
    anchor: (v) => pin.getWorldPosition(v).add(tmpVector.copy(v).normalize().multiplyScalar(0.3)),
    center: ORIGIN,
    facing: () => pin.getWorldPosition(new Vector3()).normalize(),
    visible: inSpace,
  });

  const gravityLabelsVisible = () => inMoonScene() && state.gravityStep >= 1;
  addLabel({ text: 'جاذبية القمر', type: 'force', anchor: (v) => onOrbitPlane(state.moonAngle, 0, v, GRAVITY_ROW_Y + 0.5), visible: gravityLabelsVisible });
  addLabel({ text: 'شدّ أقوى', type: 'force', anchor: (v) => onOrbitPlane(state.moonAngle, 1.9, v, GRAVITY_ROW_Y - 0.42), visible: gravityLabelsVisible });
  addLabel({ text: 'شدّ أضعف', type: 'force', anchor: (v) => onOrbitPlane(state.moonAngle, -1.6, v, GRAVITY_ROW_Y - 0.42), visible: gravityLabelsVisible });

  const effectLabelsVisible = () => inSunScene() && state.effectsVisible;
  addLabel({ text: 'أثر القمر', type: 'moon', anchor: (v) => onOrbitPlane(state.moonAngle, 3.75, v, 0.1), center: ORIGIN, visible: effectLabelsVisible });
  addLabel({ text: 'أثر الشمس', type: 'sun', anchor: (v) => onOrbitPlane(SUN_ANGLE, 3.05, v, -0.1), center: ORIGIN, visible: effectLabelsVisible });

  Object.entries(PHASES).forEach(([key, angle]) => {
    // The new-moon label goes under its marker so it does not cover the Sun.
    const underMarker = key === 'new';
    addLabel({
      text: LESSON.phaseNames[key],
      type: 'moon',
      anchor: underMarker
        ? (v) => onOrbitPlane(angle, MOON_ORBIT, v, -0.45)
        : (v) => onOrbitPlane(angle, MOON_ORBIT + 0.45, v),
      center: underMarker ? (v) => onOrbitPlane(angle, MOON_ORBIT, v) : ORIGIN,
      visible: inSunScene,
    });
  });

  function updateLabels() {
    const width = app.clientWidth;
    const height = app.clientHeight;
    const toScreen = (v) => [((v.x + 1) / 2) * width, ((1 - v.y) / 2) * height];
    const visibleLabels = [];

    labels.forEach((label) => {
      let visible = label.visible();
      if (visible) {
        label.anchor(tmpVector);
        const worldPos = tmpVector.clone();
        tmpVector.project(camera);
        if (Math.abs(tmpVector.z) > 1) visible = false;
        if (visible && label.facing) {
          const normal = label.facing();
          if (normal.dot(camera.position.clone().sub(worldPos)) < 0) visible = false;
        }
      }
      if (visible !== label.shown) {
        label.el.style.display = visible ? 'block' : 'none';
        label.shown = visible;
      }
      if (!visible) return;

      if (typeof label.text === 'function') setText(label.el, label.text());
      const current = label.el.textContent;
      if (label.width === null || label.measuredText !== current) {
        label.width = label.el.offsetWidth;
        label.height = label.el.offsetHeight;
        label.measuredText = current;
      }

      let [x, y] = toScreen(tmpVector);
      let dirX = 0;
      let dirY = 1;
      if (label.center) {
        label.center(tmpCenter).project(camera);
        const [cx, cy] = toScreen(tmpCenter);
        const dist = Math.hypot(x - cx, y - cy);
        if (dist < 0.5) {
          dirY = -1;
        } else {
          dirX = (x - cx) / dist;
          dirY = (y - cy) / dist;
        }
        const offset = (Math.abs(dirX) * label.width) / 2 + (Math.abs(dirY) * label.height) / 2 + 3;
        x += dirX * offset;
        y += dirY * offset;
      }
      visibleLabels.push({ label, x, y, dirX, dirY });
    });

    // Lower-priority labels step outward until they no longer overlap.
    visibleLabels.sort((a, b) => b.label.priority - a.label.priority);
    const placed = [];
    visibleLabels.forEach((item) => {
      const halfW = item.label.width / 2 + 2;
      const halfH = item.label.height / 2 + 1;
      for (let step = 0; step < 14; step++) {
        const overlaps = placed.some((p) => Math.abs(p.x - item.x) < p.halfW + halfW && Math.abs(p.y - item.y) < p.halfH + halfH);
        if (!overlaps) break;
        item.x += item.dirX * 6;
        item.y += item.dirY * 6;
      }
      placed.push({ x: item.x, y: item.y, halfW, halfH });
      item.label.el.style.transform = `translate(${item.x.toFixed(1)}px, ${item.y.toFixed(1)}px) translate(-50%, -50%)`;
    });
  }

  // ---------------------------------------------------------------------
  // Camera
  // ---------------------------------------------------------------------

  // Orbit camera: target, distance, horizontal angle, vertical angle.
  const VIEWS = {
    beach: { target: [0, -0.5, 1], distance: 15.5, theta: 0.62, phi: 1.12 },
    moon: { target: [0, 0, 0], distance: 17, theta: 0.35, phi: 0.92 },
    sun: { target: [-5.5, 0, 0], distance: 29, theta: 0.4, phi: 0.8 },
    moonPhone: { target: [0, 0, 0], distance: 15.5, theta: 0.35, phi: 0.92 },
    sunPhone: { target: [-4.6, 0, 0], distance: 24.5, theta: 0.35, phi: 0.78 },
  };

  const view = { target: new Vector3(), distance: 15.5, theta: 0.6, phi: 1.1 };
  const viewGoal = { target: new Vector3(), distance: 15.5, theta: 0.6, phi: 1.1 };

  function setView(name, instant = false) {
    const preset = (isPhone() && VIEWS[name + 'Phone']) || VIEWS[name];
    viewGoal.target.fromArray(preset.target);
    viewGoal.distance = preset.distance;
    viewGoal.theta = preset.theta;
    viewGoal.phi = preset.phi;
    if (instant) {
      view.target.copy(viewGoal.target);
      Object.assign(view, { distance: viewGoal.distance, theta: viewGoal.theta, phi: viewGoal.phi });
    }
  }

  // Step back on tall, narrow screens so the whole model fits.
  function aspectZoom() {
    return camera.aspect < 1.15 ? Math.pow(1.15 / camera.aspect, 0.85) : 1;
  }

  function updateCamera(dt) {
    const k = 1 - Math.exp(-dt * 5);
    view.target.lerp(viewGoal.target, k);
    view.distance += (viewGoal.distance - view.distance) * k;
    view.theta += (viewGoal.theta - view.theta) * k;
    view.phi += (viewGoal.phi - view.phi) * k;

    const r = view.distance * aspectZoom();
    camera.position.set(
      view.target.x + r * Math.sin(view.phi) * Math.sin(view.theta),
      view.target.y + r * Math.cos(view.phi),
      view.target.z + r * Math.sin(view.phi) * Math.cos(view.theta)
    );
    camera.lookAt(view.target);
  }

  // ---------------------------------------------------------------------
  // Scenes
  // ---------------------------------------------------------------------

  function setScene(name) {
    state.sceneName = name;
    const isBeach = name === 'beach';

    beachModel.visible = isBeach;
    space.visible = !isBeach;
    stars.visible = !isBeach && !ar.active && !cameraFeed.active;
    sun.visible = name === 'sun';
    phaseMarkers.visible = name === 'sun';
    gravityArrows.visible = name === 'moon';
    state.sunTideTarget = name === 'sun' ? SUN_TIDE : 0;

    app.dataset.sky = isBeach ? 'day' : 'night';
    applyLighting(isBeach ? DAY_LIGHTING : SPACE_LIGHTING);
    $('#scale-note').hidden = isBeach || state.stage === 0;
  }

  // ---------------------------------------------------------------------
  // Sound effects
  // ---------------------------------------------------------------------

  let audioContext = null;

  function playTones(frequencies, waveform, volume, spacing) {
    if (!state.sound) return;
    try {
      audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
      const start = audioContext.currentTime;
      frequencies.forEach((frequency, i) => {
        const t = start + i * spacing;
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        osc.type = waveform;
        osc.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(volume, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        osc.connect(gain).connect(audioContext.destination);
        osc.start(t);
        osc.stop(t + 0.4);
      });
    } catch (err) {
      // Audio is optional.
    }
  }

  const sounds = {
    correct: () => playTones([523, 659, 784, 1047], 'sine', 0.09, 0.11),
    wrong: () => playTones([392, 330], 'triangle', 0.06, 0.16),
    tick: () => playTones([659, 880], 'sine', 0.05, 0.12),
  };

  // ---------------------------------------------------------------------
  // Stage panel
  // ---------------------------------------------------------------------

  const GRAVITY_BUTTON_TEXT = ['أظهر قوة الجاذبية', 'ماذا يحدث للماء؟', 'أخفِ الأسهم'];
  const effectsButtonText = () => (state.effectsVisible ? 'أخفِ أثر الشمس والقمر' : 'أظهر أثر الشمس والقمر');
  const spinButtonText = () => (state.earthSpinning ? 'أوقف دوران الأرض' : 'شغّل دوران الأرض');

  function stageHeader(n, title) {
    return `<p class="panel__count">المرحلة ${toArabicDigits(n)} من ٣</p><h2>${title}</h2>`;
  }

  function stageNav(n) {
    const prev = n > 1 ? `<button class="btn btn--secondary btn--small" data-go="${n - 1}">السابق</button>` : '<span></span>';
    const next = n < 3 ? `<button class="btn btn--primary btn--small" id="next-btn" data-go="${n + 1}">التالي: ${LESSON.stageNames[n + 1]}</button>` : '';
    return `<div class="panel__nav">${prev}${next}</div>`;
  }

  function stageControls(n) {
    if (n === 1) {
      return `
        <div class="actions">
          <button class="btn btn--primary" id="gravity-btn">${GRAVITY_BUTTON_TEXT[state.gravityStep]}</button>
          <button class="btn btn--secondary btn--small" id="spin-btn" aria-pressed="${state.earthSpinning}">${spinButtonText()}</button>
        </div>
        <p class="caption" id="gravity-note"${state.gravityStep ? '' : ' hidden'}>${LESSON.gravityNotes[state.gravityStep]}</p>`;
    }
    const phaseButtons = LESSON.stages[n].phases
      .map((key) => `<button class="btn btn--secondary btn--small" data-phase="${key}">${LESSON.phaseNames[key]}</button>`)
      .join('');
    return `
      <p class="muted">اسحب القمر بإصبعك على مداره، أو اضغط اسم الطور:</p>
      <div class="phase-buttons">${phaseButtons}</div>
      <div class="actions">
        <button class="btn btn--primary btn--small" id="effects-btn" aria-pressed="${state.effectsVisible}">${effectsButtonText()}</button>
      </div>`;
  }

  function stageWidget(n) {
    if (n === 1) {
      return '<p class="note" id="rotation-count">راقب إطار «شاطئنا»: الأرض تدور حول نفسها، فيمرّ شاطئنا (العلامة الحمراء) بمناطق المد والجزر.</p>';
    }
    const lowRange = Math.round(((MOON_TIDE - SUN_TIDE) / (MOON_TIDE + SUN_TIDE)) * 100);
    return `
      <div class="widget">
        <p class="widget__title">ارتفاع المد</p>
        <div class="bar"><span>المد العالي</span><div class="bar__track"><div class="bar__fill" style="width:100%"></div></div></div>
        <div class="bar"><span>المد المنخفض</span><div class="bar__track"><div class="bar__fill" style="width:${lowRange}%"></div></div></div>
        <div class="bar bar--live"><span>الآن</span><div class="bar__track"><div class="bar__fill" id="live-bar"></div></div></div>
        <p class="muted">طور القمر: <b id="phase-name"></b></p>
        <p class="caption" id="alignment-note"></p>
      </div>`;
  }

  function conclusionMessage(n) {
    const stage = LESSON.stages[n];
    const predictedRight = state.inquiry[n].prediction === stage.prediction.answer;
    const reflection = predictedRight
      ? 'وكان توقعك في البداية صحيحًا. أحسنت!'
      : 'قارن ذلك بتوقعك في البداية: التجربة هي التي كشفت الحقيقة، وهكذا يفكر العلماء.';
    return `<b>استنتاج صحيح!</b> ${stage.conclusion.explanation}<span class="feedback__reflect">${reflection}</span>`;
  }

  function canConclude(n) {
    const inquiry = state.inquiry[n];
    return inquiry.solved || (inquiry.prediction !== null && LESSON.stages[n].tasks.every(isTaskDone));
  }

  function inquiryStageHtml(n) {
    const stage = LESSON.stages[n];
    const inquiry = state.inquiry[n];
    const unlocked = canConclude(n);

    const predictionChoices = stage.prediction.options
      .map((option, i) => `<button class="choice" data-prediction="${i}" aria-pressed="${inquiry.prediction === i}">${option}</button>`)
      .join('');

    const tasks = stage.tasks
      .map((task, i) => {
        const done = isTaskDone(task);
        return `<li id="task-${i}" class="${done ? 'is-done' : ''}"><i class="tasks__mark">${done ? '✓' : toArabicDigits(i + 1)}</i><span>${task.text}</span></li>`;
      })
      .join('');

    const conclusionChoices = stage.conclusion.options
      .map((option, i) => {
        const isRight = inquiry.solved && i === stage.conclusion.answer;
        const isWrong = !!inquiry.wrongAnswers[i];
        const cls = isRight ? ' is-right' : isWrong ? ' is-wrong' : '';
        const disabled = inquiry.solved || isWrong ? ' disabled' : '';
        return `<button class="choice${cls}" data-conclusion="${i}"${disabled}>${option}</button>`;
      })
      .join('');

    return `
      ${stageHeader(n, stage.title)}
      <p class="panel__question">${stage.question}</p>

      <div class="step">
        <p class="step__title"><span class="step__num">١</span>${stage.prediction.question}</p>
        <div class="choices">${predictionChoices}</div>
        <p class="muted" id="prediction-saved"${inquiry.prediction === null ? ' hidden' : ''}>سجّلنا توقعك. الآن جرّب لتتحقق منه!</p>
      </div>

      <div class="step">
        <p class="step__title"><span class="step__num">٢</span>جرّب واكتشف</p>
        ${stageControls(n)}
        <ul class="tasks">${tasks}</ul>
        ${stageWidget(n)}
      </div>

      <div class="step${unlocked ? '' : ' is-locked'}" id="conclusion-step">
        <p class="step__title"><span class="step__num">٣</span>${stage.conclusion.question}</p>
        <p class="muted" id="conclusion-lock"${unlocked ? ' hidden' : ''}></p>
        <div class="choices" id="conclusion-choices"${unlocked ? '' : ' hidden'}>${conclusionChoices}</div>
        <p class="feedback feedback--good" id="conclusion-feedback"${inquiry.solved ? '' : ' hidden'}>${inquiry.solved ? conclusionMessage(n) : ''}</p>
      </div>

      ${stageNav(n)}`;
  }

  function renderPanel(n) {
    panel.innerHTML = `<button class="panel__toggle" id="panel-toggle" aria-expanded="true">إخفاء اللوحة</button>${inquiryStageHtml(n)}`;
    panel.classList.remove('is-collapsed');
    dockBeachFrame();
    bindPanel(n);
    refreshInquiry(true);
  }

  function bindPanel(n) {
    $$('[data-go]', panel).forEach((btn) => {
      btn.onclick = () => goToStage(Number(btn.dataset.go));
    });

    $('#panel-toggle').onclick = function () {
      const collapsed = panel.classList.toggle('is-collapsed');
      this.textContent = collapsed ? 'إظهار اللوحة' : 'إخفاء اللوحة';
      this.setAttribute('aria-expanded', String(!collapsed));
      setTimeout(layout, 30);
    };

    const stage = LESSON.stages[n];
    const inquiry = state.inquiry[n];

    $$('[data-prediction]', panel).forEach((btn) => {
      btn.onclick = () => {
        inquiry.prediction = Number(btn.dataset.prediction);
        $$('[data-prediction]', panel).forEach((other) => other.setAttribute('aria-pressed', String(other === btn)));
        $('#prediction-saved').hidden = false;
        refreshInquiry(true);
      };
    });

    $$('[data-conclusion]', panel).forEach((btn) => {
      btn.onclick = () => {
        if (inquiry.solved) return;
        const choice = Number(btn.dataset.conclusion);
        const feedback = $('#conclusion-feedback');

        if (choice === stage.conclusion.answer) {
          inquiry.solved = true;
          btn.classList.add('is-right');
          $$('[data-conclusion]', panel).forEach((other) => { other.disabled = true; });
          feedback.className = 'feedback feedback--good';
          feedback.innerHTML = conclusionMessage(n);
          feedback.hidden = false;
          sounds.correct();
          launchConfetti();
          markStageDone(n);
        } else {
          inquiry.wrongAnswers[choice] = true;
          btn.classList.remove('is-wrong');
          void btn.offsetWidth; // restart the shake animation
          btn.classList.add('is-wrong');
          btn.disabled = true;
          feedback.className = 'feedback feedback--hint';
          feedback.innerHTML = `<b>فكرة تساعدك:</b> ${stage.conclusion.hint} حاول مرة أخرى.`;
          feedback.hidden = false;
          sounds.wrong();
        }
      };
    });

    if (n === 1) {
      $('#gravity-btn').onclick = function () {
        state.gravityStep = (state.gravityStep + 1) % 3;
        state.gravityStepMax = Math.max(state.gravityStepMax, state.gravityStep);
        const note = $('#gravity-note');
        note.hidden = state.gravityStep === 0;
        note.innerHTML = LESSON.gravityNotes[state.gravityStep];
        this.textContent = GRAVITY_BUTTON_TEXT[state.gravityStep];
      };
      $('#spin-btn').onclick = function () {
        state.earthSpinning = !state.earthSpinning;
        this.setAttribute('aria-pressed', String(state.earthSpinning));
        this.textContent = spinButtonText();
      };
    } else {
      $$('[data-phase]', panel).forEach((btn) => {
        btn.onclick = () => { state.moonTarget = PHASES[btn.dataset.phase]; };
      });
      $('#effects-btn').onclick = function () {
        state.effectsVisible = !state.effectsVisible;
        if (state.effectsVisible) state.effectsSeen[n] = true;
        this.setAttribute('aria-pressed', String(state.effectsVisible));
        this.textContent = effectsButtonText();
      };
    }

    updateNextButton();
  }

  // Ticks finished tasks and unlocks the conclusion step. Runs every frame.
  function refreshInquiry(silent) {
    const n = state.stage;
    if (n < 1 || n > 3 || panel.hidden) return;

    const stage = LESSON.stages[n];
    const inquiry = state.inquiry[n];

    stage.tasks.forEach((task, i) => {
      const done = isTaskDone(task);
      const item = document.getElementById('task-' + i);
      if (item && item.classList.contains('is-done') !== done) {
        item.classList.toggle('is-done', done);
        item.querySelector('.tasks__mark').textContent = done ? '✓' : toArabicDigits(i + 1);
        if (done && !silent) sounds.tick();
      }
    });

    const step = $('#conclusion-step');
    if (!step) return;
    const unlocked = canConclude(n);
    if (step.classList.contains('is-locked') === unlocked) {
      step.classList.toggle('is-locked', !unlocked);
      $('#conclusion-choices').hidden = !unlocked;
      $('#conclusion-lock').hidden = unlocked;
      if (unlocked && !silent) sounds.tick();
    }
    if (!unlocked) {
      setText(
        $('#conclusion-lock'),
        inquiry.prediction === null ? 'اختر توقعك أولًا، ثم أكمل المهام لتفتح الاستنتاج.' : 'أكمل المهام كلها لتفتح الاستنتاج.'
      );
    }
  }

  function markStageDone(n) {
    if (state.completed[n - 1]) return;
    state.completed[n - 1] = true;
    updateStageTabs();
    updateNextButton();
  }

  function updateNextButton() {
    const next = $('#next-btn');
    if (next) next.classList.toggle('is-ready', !!state.completed[state.stage - 1]);
  }

  function updateStageTabs() {
    $$('.stage-tab').forEach((tab) => {
      const n = Number(tab.dataset.stage);
      const done = state.completed[n - 1];
      tab.classList.toggle('is-done', done);
      if (n === state.stage) tab.setAttribute('aria-current', 'step');
      else tab.removeAttribute('aria-current');
      tab.querySelector('.stage-tab__num').textContent = done ? '✓' : toArabicDigits(n);
    });
    const doneCount = state.completed.filter(Boolean).length;
    $('#progress-fill').style.width = (doneCount / 3) * 100 + '%';
  }

  function goToStage(n) {
    state.stage = n;
    state.gravityStep = 0;
    state.effectsVisible = false;
    startScreen.hidden = true;
    panel.hidden = false;

    if (n === 1) {
      setScene('moon');
      setView('moon');
    } else {
      setScene('sun');
      setView('sun');
      // Start between phases so students move the Moon themselves.
      if (!state.inquiry[n].solved) state.moonTarget = n === 2 ? 2.25 : 0.75;
    }

    renderPanel(n);
    updateStageTabs();
    setTimeout(layout, 20);
  }

  // ---------------------------------------------------------------------
  // Confetti
  // ---------------------------------------------------------------------

  const confettiCanvas = $('#confetti');
  const confettiCtx = confettiCanvas.getContext('2d');
  const CONFETTI_COLORS = ['#ffc83d', '#47b0ff', '#45d6a6', '#ff8a7a', '#cfd8e6'];
  let confetti = [];
  let confettiDrawn = false;

  function launchConfetti(big = false) {
    if (reduceMotion) return;
    const count = big ? 140 : 60;
    for (let i = 0; i < count; i++) {
      confetti.push({
        x: app.clientWidth * (0.2 + Math.random() * 0.6),
        y: app.clientHeight * 0.35,
        vx: (Math.random() - 0.5) * 7,
        vy: -4 - Math.random() * 6,
        size: 3 + Math.random() * 4,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        life: 1,
      });
    }
  }

  function drawConfetti(dt) {
    const width = app.clientWidth;
    const height = app.clientHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);

    if (!confetti.length) {
      if (confettiDrawn) {
        confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
        confettiDrawn = false;
      }
      return;
    }

    if (confettiCanvas.width !== Math.round(width * ratio)) {
      confettiCanvas.width = Math.round(width * ratio);
      confettiCanvas.height = Math.round(height * ratio);
    }
    confettiDrawn = true;
    confettiCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
    confettiCtx.clearRect(0, 0, width, height);

    confetti = confetti.filter((p) => {
      p.vy += 14 * dt;
      p.x += p.vx * dt * 30;
      p.y += p.vy * dt * 30;
      p.life -= dt * 0.45;
      confettiCtx.globalAlpha = Math.max(0, p.life);
      confettiCtx.fillStyle = p.color;
      confettiCtx.beginPath();
      confettiCtx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      confettiCtx.fill();
      return p.life > 0 && p.y < height + 20;
    });
    confettiCtx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------------
  // Pointer and keyboard input
  // ---------------------------------------------------------------------

  const canvas = $('#scene');
  const pointers = new Map();
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  const orbitPlane = new THREE.Plane(new Vector3(0, 1, 0), 0);
  let orbitDrag = null;
  let pinchDistance = 0;

  function aimRay(event) {
    const rect = canvas.getBoundingClientRect();
    pointerNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(pointerNdc, camera);
  }

  const canDragMoon = () => inSpace() && startScreen.hidden;

  function pointerIsOnMoon(event) {
    aimRay(event);
    const target = new THREE.Sphere(moon.getWorldPosition(new Vector3()), 0.9 * world.scale.x);
    return raycaster.ray.intersectsSphere(target);
  }

  function zoomBy(factor) {
    viewGoal.distance = clamp(viewGoal.distance * factor, 6, 48);
  }

  // Marks Moon phases the student has reached (stages 2 and 3).
  function recordVisitedPhase() {
    if (!inSunScene()) return;
    Object.entries(PHASES).forEach(([key, angle]) => {
      if (Math.abs(angleDiff(state.moonAngle, angle)) < 0.12) state.visitedPhases[key] = true;
    });
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (ar.active) return;
    try { canvas.setPointerCapture(event.pointerId); } catch (err) { /* not supported */ }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.size === 1) {
      if (canDragMoon() && pointerIsOnMoon(event)) {
        state.draggingMoon = true;
        state.moonTarget = null;
      } else {
        orbitDrag = { x: event.clientX, y: event.clientY };
      }
    } else {
      state.draggingMoon = false;
      orbitDrag = null;
      const [a, b] = Array.from(pointers.values());
      pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) {
      if (canDragMoon()) canvas.classList.toggle('over-moon', pointerIsOnMoon(event));
      return;
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (state.draggingMoon) {
      aimRay(event);
      const hit = new Vector3();
      if (raycaster.ray.intersectPlane(orbitPlane, hit)) {
        space.worldToLocal(hit);
        const angle = Math.atan2(-hit.z, hit.x);
        state.dragDistance += Math.abs(angleDiff(angle, state.moonAngle));
        state.moonAngle = angle;
        state.moonWasDragged = true;
        recordVisitedPhase();
      }
      return;
    }

    if (pointers.size === 2) {
      const [a, b] = Array.from(pointers.values());
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDistance > 0) zoomBy(pinchDistance / distance);
      pinchDistance = distance;
      return;
    }

    if (orbitDrag) {
      const dx = event.clientX - orbitDrag.x;
      const dy = event.clientY - orbitDrag.y;
      orbitDrag = { x: event.clientX, y: event.clientY };
      viewGoal.theta -= dx * 0.007;
      viewGoal.phi = clamp(viewGoal.phi - dy * 0.006, 0.15, 1.5);
    }
  });

  function endPointer(event) {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchDistance = 0;
    if (!pointers.size) {
      orbitDrag = null;
      state.draggingMoon = false;
    }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoomBy(1 + event.deltaY * 0.001);
  }, { passive: false });

  window.addEventListener('keydown', (event) => {
    const target = event.target;
    if (target && target.tagName === 'BUTTON' && (event.key === ' ' || event.key === 'Enter')) return;
    switch (event.key) {
      case 'ArrowLeft': viewGoal.theta -= 0.15; break;
      case 'ArrowRight': viewGoal.theta += 0.15; break;
      case 'ArrowUp': viewGoal.phi = Math.max(0.15, viewGoal.phi - 0.1); break;
      case 'ArrowDown': viewGoal.phi = Math.min(1.5, viewGoal.phi + 0.1); break;
      case '+':
      case '=': zoomBy(0.9); break;
      case '-': zoomBy(1.1); break;
      default: break;
    }
  });

  // ---------------------------------------------------------------------
  // Per-frame updates
  // ---------------------------------------------------------------------

  const EARTH_SPIN_SPEED = 0.5; // radians per second
  const beachStatePill = $('#beach-state');
  let beachLevel = null;

  // Water level in the beach frame, driven by the tide at the Bahrain pin.
  function updateBeachModel(dt, time) {
    let target;
    if (inBeachScene()) {
      if (!reduceMotion) state.tideClock += (dt * TIDE_PERIOD) / 16;
      target = ambientTideLevel(state.tideClock);
      beachLevel = target;
    } else {
      target = TIDE_MEAN + (state.beach.height - 0.11) * 1.82;
      beachLevel = beachLevel === null ? target : beachLevel + (target - beachLevel) * Math.min(1, dt * 5);
    }

    waterBody.scale.y = beachLevel - TANK_FLOOR;
    waterSurface.position.y = beachLevel;

    const surface = waterSurface.geometry.attributes.position.array;
    const ripple = reduceMotion ? 0.008 : 0.028;
    for (let i = 0; i < surface.length; i += 3) {
      const x = waterSurfaceBase[i];
      const z = waterSurfaceBase[i + 2];
      surface[i + 1] = Math.sin(x * 1.3 + time * 1.3) * ripple + Math.cos(z * 1.7 + time * 0.9) * ripple * 0.8;
    }
    waterSurface.geometry.attributes.position.needsUpdate = true;
    waterSurface.geometry.computeVertexNormals();

    const bob = reduceMotion ? 0 : Math.sin(time * 1.6) * 0.03;
    const floatY = beachLevel + 0.07 + bob;
    sailBoat.position.y = floatY;
    sailBoat.rotation.z = bob * 1.5;

    const groundY = sandHeight(fishingBoat.position.z) + 0.3;
    fishingBoat.position.y = Math.max(floatY, groundY);
    fishingBoat.rotation.z = floatY < groundY ? 0.14 : bob * 1.5;
  }

  // Tide height at the pin for a given Earth rotation.
  function tideAtPin(earthRotation) {
    const x = bahrainDirection.x * Math.cos(earthRotation) + bahrainDirection.z * Math.sin(earthRotation);
    const z = -bahrainDirection.x * Math.sin(earthRotation) + bahrainDirection.z * Math.cos(earthRotation);
    const cosToMoon = x * Math.cos(state.moonAngle) - z * Math.sin(state.moonAngle);
    const cosToSun = x * Math.cos(SUN_ANGLE) - z * Math.sin(SUN_ANGLE);
    return tideHeight(cosToMoon, cosToSun, state.moonTide, state.sunTide);
  }

  function updatePinTide(dt) {
    const tide = state.beach;
    const height = tideAtPin(earthSpin.rotation.y);

    // Count high and low waters over one full Earth rotation.
    if (tide.previous !== null && state.earthSpinning) {
      const delta = height - tide.previous;
      if (tide.previousDelta > 0 && delta <= 0) tide.highs++;
      if (tide.previousDelta < 0 && delta >= 0) tide.lows++;
      if (Math.abs(delta) > 1e-7) {
        tide.previousDelta = delta;
        tide.rising = delta > 0;
      }
      tide.turned += dt * EARTH_SPIN_SPEED * (reduceMotion ? 0.5 : 1);
      if (tide.turned >= Math.PI * 2) {
        tide.turned -= Math.PI * 2;
        tide.lastHighs = tide.highs;
        tide.lastLows = tide.lows;
        tide.highs = 0;
        tide.lows = 0;
      }
    }
    tide.previous = height;
    tide.height = height;

    // Position within today's range, sampled around the pin's latitude circle.
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 24; i++) {
      const h = tideAtPin((i / 24) * Math.PI * 2);
      min = Math.min(min, h);
      max = Math.max(max, h);
    }
    tide.relative = clamp((height - min) / Math.max(1e-6, max - min), 0, 1);

    let text;
    let isHigh;
    if (tide.relative > 0.82) {
      text = 'مدّ: الماء مرتفع';
      isHigh = true;
    } else if (tide.relative < 0.18) {
      text = 'جزر: الماء منخفض';
      isHigh = false;
    } else {
      text = tide.rising ? 'الماء يرتفع' : 'الماء ينخفض';
      isHigh = tide.rising;
    }
    const pill = beachStatePill;
    setText(pill, text);
    const pillClass = isHigh ? 'pill pill--high' : 'pill pill--low';
    if (pill.className !== pillClass) pill.className = pillClass;

    const counter = $('#rotation-count');
    if (counter && tide.lastHighs !== null) {
      setText(counter, `في دورة كاملة للأرض حول نفسها: ارتفع الماء على شاطئنا ${toArabicDigits(tide.lastHighs)} مرة، وانخفض ${toArabicDigits(tide.lastLows)} مرة.`);
    }
  }

  function updateTideBars() {
    const liveBar = $('#live-bar');
    if (!liveBar || (state.stage !== 2 && state.stage !== 3)) return;

    liveBar.style.width = Math.round((combinedTide().range / (MOON_TIDE + SUN_TIDE)) * 100) + '%';

    const fromSun = angleDiff(state.moonAngle, SUN_ANGLE);
    const near = (a, b) => Math.abs(a - b) < 0.3;
    let phaseName = 'بين طورين';
    if (Math.abs(fromSun) < 0.3) phaseName = LESSON.phaseNames.new;
    else if (Math.abs(fromSun) > Math.PI - 0.3) phaseName = LESSON.phaseNames.full;
    else if (near(fromSun, Math.PI / 2)) phaseName = LESSON.phaseNames.firstQuarter;
    else if (near(fromSun, -Math.PI / 2)) phaseName = LESSON.phaseNames.lastQuarter;
    setText($('#phase-name'), phaseName);

    const alignment = Math.cos(2 * fromSun);
    const mode = alignment > 0.85 ? 'aligned' : alignment < -0.85 ? 'square' : 'between';
    const note = $('#alignment-note');
    if (note.dataset.mode !== mode) {
      note.dataset.mode = mode;
      const prompt = 'راقب إطار «شاطئنا» وشريط «الآن»: هل ارتفع الماء أكثر أم أقل؟';
      note.innerHTML = {
        aligned: `<b>الشمس والأرض والقمر على استقامة واحدة.</b> ${prompt}`,
        square: `<b>جاذبية القمر وجاذبية الشمس متعامدتان.</b> ${prompt}`,
        between: 'القمر بين طورين. حرّكه إلى أحد الأطوار.',
      }[mode];
    }
  }

  function updateSpace(dt, time) {
    if (state.earthSpinning) {
      earthSpin.rotation.y += dt * EARTH_SPIN_SPEED * (reduceMotion ? 0.5 : 1);
    }

    if (state.moonTarget !== null && !state.draggingMoon) {
      const remaining = angleDiff(state.moonTarget, state.moonAngle);
      state.moonAngle += remaining * Math.min(1, dt * 2.5);
      if (Math.abs(remaining) < 0.003) {
        state.moonAngle = state.moonTarget;
        state.moonTarget = null;
      }
      recordVisitedPhase();
    } else if (inMoonScene() && !state.draggingMoon && state.earthSpinning) {
      state.moonAngle += (dt * EARTH_SPIN_SPEED) / 27.3; // one orbit per ~27 days
    }

    state.sunTide += (state.sunTideTarget - state.sunTide) * Math.min(1, dt * 3);

    moonPosition(moon.position);
    moon.rotation.y = state.moonAngle + Math.PI;
    updateOcean(state.moonTide, state.sunTide, state.moonAngle);

    gravityArrows.rotation.y = state.moonAngle;
    pullArrows.visible = state.gravityStep >= 1;
    stretchArrows.visible = state.gravityStep >= 2;
    const pulse = reduceMotion ? 1 : 0.94 + 0.06 * Math.sin(time * 2.4);
    pullArrows.children.forEach((child) => { if (child.type === 'Group') child.scale.x = pulse; });
    stretchArrows.children.forEach((child) => { child.scale.x = pulse; });

    moonEffect.rotation.y = state.moonAngle;
    moonEffect.visible = sunEffect.visible = inSunScene() && state.effectsVisible;

    const invite = state.stage >= 1 && state.stage <= 3 && !state.moonWasDragged;
    setText(moonLabel.el, invite ? 'القمر · اسحبني' : 'القمر');

    updatePinTide(dt);
    updateTideBars();
  }

  let lastFrame = performance.now();

  function frame(time, xrFrame) {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    const seconds = now / 1000;
    lastFrame = now;

    if (!ar.active) {
      const idle = state.stage === 0;
      if (idle && !reduceMotion && !cameraFeed.active) viewGoal.theta += dt * 0.05;
      updateCamera(dt);
      if (cameraFeed.active && motion.current) camera.quaternion.multiply(motion.delta());
    }

    const beachFrameActive = inSpace() && !ar.active && beachFrame.isShowing();
    if (space.visible) updateSpace(dt, seconds);
    if (beachModel.visible || beachFrameActive) updateBeachModel(dt, seconds);
    if (xrFrame) ar.update(xrFrame);

    renderer.render(scene, camera);
    if (beachFrameActive) beachFrame.render();
    if (!ar.active) updateLabels();

    refreshInquiry(false);
    drawConfetti(dt);
  }

  // ---------------------------------------------------------------------
  // Layout: keep the model inside the free area of the screen
  // ---------------------------------------------------------------------

  function layout() {
    const width = app.clientWidth;
    const height = app.clientHeight;
    if (!width || !height) return;

    renderer.setSize(width, height, false);
    const topbarHeight = $('.topbar').offsetHeight;
    panel.style.top = isPhone() ? '' : topbarHeight + 12 + 'px';
    $('#scale-note').style.top = topbarHeight + 8 + 'px';
    labels.forEach((label) => { label.width = null; });

    // Free area: below the top bar, beside the panel (desktop) or above it (phone).
    const appRect = app.getBoundingClientRect();
    let left = 0;
    let top = ar.active ? 0 : topbarHeight;
    let right = width;
    let bottom = height;
    if (!panel.hidden && !ar.active) {
      const panelRect = panel.getBoundingClientRect();
      if (isPhone()) bottom = Math.max(top + 120, panelRect.top - appRect.top);
      else right = Math.max(width * 0.4, panelRect.left - appRect.left - 8);
    }

    const areaWidth = right - left;
    const areaHeight = bottom - top;
    camera.aspect = areaWidth / areaHeight;
    camera.setViewOffset(areaWidth, areaHeight, -left, -top, width, height);
    camera.updateProjectionMatrix();
  }

  window.addEventListener('resize', layout);
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(layout);
    observer.observe(panel);
    observer.observe($('.topbar'));
  }

  // ---------------------------------------------------------------------
  // "Our beach" frame: a second renderer docked at the top of the panel
  // ---------------------------------------------------------------------

  const beachFrame = (() => {
    const box = $('#beach');
    const viewEl = $('#beach-view');
    const frameCamera = new THREE.PerspectiveCamera(40, 1.6, 0.05, 200);
    let frameRenderer = null;
    let size = { width: 0, height: 0 };

    try {
      frameRenderer = new THREE.WebGLRenderer({ antialias: true });
      frameRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      frameRenderer.setClearColor(0xb9e5fa, 1);
      frameRenderer.domElement.style.cssText = 'display:block;width:100%;height:100%';
      viewEl.appendChild(frameRenderer.domElement);
    } catch (err) {
      frameRenderer = null;
    }

    function dock() {
      const wanted = !!frameRenderer && state.stage >= 1 && state.stage <= 3;
      if (wanted && panel.children[1] !== box) panel.insertBefore(box, panel.children[1] || null);
      setHidden(box, !wanted);
    }

    function isShowing() {
      return !!frameRenderer && !box.hidden && state.showBeach && !panel.classList.contains('is-collapsed');
    }

    function fitCamera(width, height) {
      const aspect = width / height;
      const distance = 17 * (aspect < 1.5 ? Math.pow(1.5 / aspect, 0.8) : 1);
      const theta = 0.55;
      const phi = 1.1;
      frameCamera.aspect = aspect;
      frameCamera.position.set(
        distance * Math.sin(phi) * Math.sin(theta),
        -0.3 + distance * Math.cos(phi),
        1 + distance * Math.sin(phi) * Math.cos(theta)
      );
      frameCamera.lookAt(0, -0.3, 1);
      frameCamera.updateProjectionMatrix();
    }

    // Renders only the beach, in daylight, then restores the space scene.
    function render() {
      const width = viewEl.clientWidth;
      const height = viewEl.clientHeight;
      if (width < 8 || height < 8) return;
      if (width !== size.width || height !== size.height) {
        size = { width, height };
        frameRenderer.setSize(width, height, false);
        fitCamera(width, height);
      }

      const saved = {
        space: space.visible,
        beach: beachModel.visible,
        stars: stars.visible,
        reticle: ar.reticle.visible,
        lighting: {
          hemi: hemiLight.intensity,
          ambient: ambientLight.intensity,
          sun: sunLight.intensity,
          sunPosition: sunLight.position.toArray(),
        },
      };

      space.visible = false;
      beachModel.visible = true;
      stars.visible = false;
      ar.reticle.visible = false;
      applyLighting(DAY_LIGHTING);

      frameRenderer.render(scene, frameCamera);

      space.visible = saved.space;
      beachModel.visible = saved.beach;
      stars.visible = saved.stars;
      ar.reticle.visible = saved.reticle;
      applyLighting(saved.lighting);
    }

    $('#beach-toggle').onclick = function () {
      state.showBeach = !state.showBeach;
      box.classList.toggle('is-collapsed', !state.showBeach);
      this.textContent = state.showBeach ? 'إخفاء' : 'أظهر';
      this.setAttribute('aria-expanded', String(state.showBeach));
    };

    return { dock, isShowing, render };
  })();

  function dockBeachFrame() {
    beachFrame.dock();
  }

  // ---------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------

  const toastEl = $('#toast');
  let toastTimer = null;

  function showToast(html) {
    toastEl.innerHTML = html;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 9000);
  }
  toastEl.onclick = () => { toastEl.hidden = true; };

  // ---------------------------------------------------------------------
  // Camera pass-through ("المحيط في الفصل")
  // ---------------------------------------------------------------------

  // Device orientation keeps the model fixed in the room while the phone moves.
  const motion = (() => {
    const euler = new THREE.Euler();
    const screenTilt = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
    const screenTurn = new THREE.Quaternion();
    const zAxis = new Vector3(0, 0, 1);
    const deltaQuat = new THREE.Quaternion();
    const api = { current: null, reference: null, listening: false };

    function onOrientation(event) {
      if (event.alpha == null && event.beta == null) return;
      const toRad = Math.PI / 180;
      const screenAngle = ((screen.orientation && screen.orientation.angle) || window.orientation || 0) * toRad;
      const q = api.current || new THREE.Quaternion();
      euler.set((event.beta || 0) * toRad, (event.alpha || 0) * toRad, -(event.gamma || 0) * toRad, 'YXZ');
      q.setFromEuler(euler);
      q.multiply(screenTilt);
      q.multiply(screenTurn.setFromAxisAngle(zAxis, -screenAngle));
      api.current = q;
      if (!api.reference) api.reference = q.clone();
    }

    api.start = () => {
      const listen = () => {
        if (api.listening) return;
        window.addEventListener('deviceorientation', onOrientation);
        api.listening = true;
      };
      // iOS asks for permission first.
      if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
        return DeviceOrientationEvent.requestPermission()
          .then((result) => { if (result === 'granted') listen(); })
          .catch(() => {});
      }
      if (window.DeviceOrientationEvent) listen();
      return Promise.resolve();
    };

    api.stop = () => {
      if (api.listening) window.removeEventListener('deviceorientation', onOrientation);
      api.listening = false;
      api.current = null;
      api.reference = null;
    };

    api.recenter = () => {
      if (api.current) api.reference = api.current.clone();
    };

    api.delta = () => deltaQuat.copy(api.reference).invert().multiply(api.current);

    return api;
  })();

  const cameraFeed = { active: false, stream: null };
  const cameraBtn = $('#camera-btn');
  const recenterBtn = $('#recenter-btn');
  const video = $('#camera-feed');

  function stopCameraFeed() {
    cameraFeed.active = false;
    if (cameraFeed.stream) cameraFeed.stream.getTracks().forEach((track) => track.stop());
    cameraFeed.stream = null;
    video.srcObject = null;
    video.hidden = true;
    app.classList.remove('camera-on');
    motion.stop();
    cameraBtn.setAttribute('aria-pressed', 'false');
    cameraBtn.textContent = 'المحيط في الفصل';
    recenterBtn.hidden = true;
    setScene(state.sceneName);
  }

  function startCameraFeed() {
    const motionReady = motion.start();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('<b>الكاميرا غير متاحة في هذه الصفحة.</b><br>افتح ملف <b>index.html</b> من رابط https (مثل GitHub Pages) على الهاتف أو الجهاز اللوحي.');
      return;
    }

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then((stream) => {
        cameraFeed.stream = stream;
        cameraFeed.active = true;
        video.srcObject = stream;
        video.hidden = false;
        const playing = video.play();
        if (playing && playing.catch) playing.catch(() => {});

        app.classList.add('camera-on');
        setScene(state.sceneName);
        cameraBtn.setAttribute('aria-pressed', 'true');
        cameraBtn.textContent = 'إيقاف الكاميرا';
        recenterBtn.hidden = false;

        motionReady.then(() => {
          setTimeout(() => {
            showToast(motion.current
              ? '<b>حرّك الجهاز حولك:</b> المشهد ثابت في مكانه داخل الفصل. اضغط «توسيط المشهد» لإعادته أمامك.'
              : '<b>الكاميرا تعمل.</b> لم يُعثر على مستشعر الحركة، لذا دوّر المشهد بإصبعك.');
          }, 900);
        });
      })
      .catch((err) => {
        const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
        showToast(denied
          ? '<b>لم يُسمح باستخدام الكاميرا.</b><br>افتح ملف <b>index.html</b> من رابط https، ثم اسمح بالكاميرا عندما يطلب المتصفح.'
          : '<b>تعذّر تشغيل الكاميرا.</b> تأكد من وجود كاميرا وعدم استخدامها في تطبيق آخر.');
      });
  }

  cameraBtn.onclick = () => (cameraFeed.active ? stopCameraFeed() : startCameraFeed());
  recenterBtn.onclick = motion.recenter;

  // ---------------------------------------------------------------------
  // WebXR: place the model on a real table
  // ---------------------------------------------------------------------

  const ar = (() => {
    const arBtn = $('#ar-btn');
    const hint = $('#ar-hint');
    const api = { active: false, supported: false, session: null, hitSource: null, saved: null };

    api.reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.06, 0.08, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffc83d })
    );
    api.reticle.matrixAutoUpdate = false;
    api.reticle.visible = false;
    scene.add(api.reticle);

    const controller = renderer.xr.getController(0);
    scene.add(controller);

    // Tap to place the model on the detected surface.
    controller.addEventListener('select', () => {
      if (!api.active || !api.reticle.visible) return;
      const scale = inBeachScene() ? 0.035 : 0.03;
      world.scale.setScalar(scale);
      world.position.setFromMatrixPosition(api.reticle.matrix);
      world.position.y += inBeachScene() ? 2.1 * scale : 0.08;
      world.visible = true;
      hint.hidden = true;
    });

    api.update = (xrFrame) => {
      if (!api.active || !api.hitSource) return;
      const hits = xrFrame.getHitTestResults(api.hitSource);
      if (hits.length) {
        const pose = hits[0].getPose(renderer.xr.getReferenceSpace());
        api.reticle.visible = true;
        api.reticle.matrix.fromArray(pose.transform.matrix);
      } else {
        api.reticle.visible = false;
      }
    };

    if (navigator.xr && navigator.xr.isSessionSupported) {
      navigator.xr.isSessionSupported('immersive-ar')
        .then((supported) => { api.supported = !!supported; })
        .catch(() => {});
    }

    function onSessionEnd() {
      api.active = false;
      api.session = null;
      api.hitSource = null;
      renderer.xr.enabled = false;
      api.reticle.visible = false;
      world.visible = true;
      world.scale.setScalar(api.saved.scale);
      world.position.copy(api.saved.position);
      app.classList.remove('ar');
      labelLayer.hidden = false;
      hint.hidden = true;
      arBtn.textContent = 'على الطاولة (AR)';
      setScene(state.sceneName);
      layout();
    }

    function start() {
      navigator.xr
        .requestSession('immersive-ar', { requiredFeatures: ['hit-test'], optionalFeatures: ['dom-overlay'], domOverlay: { root: app } })
        .then((session) => {
          api.session = session;
          api.active = true;
          renderer.xr.enabled = true;
          renderer.xr.setReferenceSpaceType('local');
          renderer.xr.setSession(session);

          api.saved = { scale: world.scale.x, position: world.position.clone() };
          world.visible = false;
          stars.visible = false;
          app.classList.add('ar');
          labelLayer.hidden = true;
          hint.hidden = false;
          arBtn.textContent = 'إنهاء AR';

          session.requestReferenceSpace('viewer')
            .then((viewerSpace) => session.requestHitTestSource({ space: viewerSpace }))
            .then((source) => { api.hitSource = source; })
            .catch(() => {});
          session.addEventListener('end', onSessionEnd);
        })
        .catch(() => {
          arBtn.textContent = 'AR غير متاح هنا';
          setTimeout(() => { arBtn.textContent = 'على الطاولة (AR)'; }, 2500);
        });
    }

    arBtn.onclick = () => {
      if (api.session) {
        api.session.end();
        return;
      }
      if (!api.supported) {
        showToast('<b>وضع AR غير متاح على هذا الجهاز.</b><br>يعمل عند فتح ملف <b>index.html</b> من رابط https على هاتف أندرويد (Chrome مع ARCore) أو نظارة Meta Quest 3.');
        return;
      }
      start();
    };

    // Taps on the page controls should not place the model.
    [panel, $('.topbar')].forEach((el) => {
      el.addEventListener('beforexrselect', (event) => event.preventDefault());
    });

    return api;
  })();

  // ---------------------------------------------------------------------
  // Top bar and start screen
  // ---------------------------------------------------------------------

  function resetAll() {
    state = createState(state);
    panel.hidden = true;
    startScreen.hidden = false;
    earthSpin.rotation.y = 0;
    setScene('beach');
    setView('beach');
    updateStageTabs();
    layout();
  }

  $$('.stage-tab').forEach((tab) => {
    tab.onclick = () => goToStage(Number(tab.dataset.stage));
  });

  $('#start-btn').onclick = () => goToStage(1);
  $('#reset-btn').onclick = resetAll;
  $('#sound-btn').onclick = function () {
    state.sound = !state.sound;
    this.setAttribute('aria-pressed', String(state.sound));
  };

  setScene('beach');
  setView('beach', true);
  updateStageTabs();
  layout();
  renderer.setAnimationLoop(frame);
})();
