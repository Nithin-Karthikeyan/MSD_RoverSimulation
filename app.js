"use strict";

const mapCanvas = document.querySelector("#map-canvas");
const mapCtx = mapCanvas.getContext("2d");

const steeringCanvas = document.querySelector("#steering-canvas");
const steeringCtx = steeringCanvas.getContext("2d");

const plotCanvas = document.querySelector("#plot-canvas");
const plotCtx = plotCanvas.getContext("2d");

const UI = {
  traversalMode: document.querySelector("#traversal-mode"),
  steeringMode: document.querySelector("#steering-mode"),
  hint: document.querySelector("#mode-hint"),
  message: document.querySelector("#map-message"),

  traversalActions: document.querySelector("#traversal-actions"),
  steeringActions: document.querySelector("#steering-actions"),
  mapFrame: document.querySelector(".map-frame"),
  steeringFrame: document.querySelector("#steering-frame"),

  start: document.querySelector("#start-button"),
  pause: document.querySelector("#pause-button"),
  reset: document.querySelector("#reset-button"),

  steeringPause: document.querySelector("#steering-pause"),
  steeringHome: document.querySelector("#steering-home"),
  configurations: [...document.querySelectorAll(".configuration-button")],

  waypointReadout: document.querySelector("#waypoint-readout"),
  configReadout: document.querySelector("#configuration-readout"),

  runDot: document.querySelector("#run-dot"),
  runState: document.querySelector("#run-state"),

  graphTitle: document.querySelector("#graph-title"),
  graphTabs: document.querySelector("#graph-tabs"),
  graphButtons: [...document.querySelectorAll(".graph-tab")],
  wheelSelect: document.querySelector("#wheel-select"),
  wheelSelectLabel: document.querySelector("#wheel-select-label"),

  driveController: document.querySelector("#drive-controller"),
  steerSummary: document.querySelector("#steer-summary"),
  driveSummary: document.querySelector("#drive-summary"),

  speed: document.querySelector("#speed-telemetry"),
  heading: document.querySelector("#heading-telemetry"),
  target: document.querySelector("#target-telemetry"),
  angle: document.querySelector("#angle-telemetry"),
};

const WHEEL_NAMES = ["Front left", "Front right", "Rear left", "Rear right"];
const WHEEL_TAGS = ["FL", "FR", "RL", "RR"];

const WHEEL_POSITIONS = [
  { x: 0.70, y: 0.475 },
  { x: 0.70, y: -0.475 },
  { x: -0.70, y: 0.475 },
  { x: -0.70, y: -0.475 },
];

const WHEEL_BASE = 1.4;
const MAP = { width: 10.5, height: 6.6, pixelsPerMetre: 100 };

const MAX_STEER = degToRad(90);
const MAX_SPEED = 1.0;
const MAX_STEER_COMMAND = degToRad(220);

const SAMPLE_PERIOD = 0.035;
const HISTORY_SECONDS = 10;
const HISTORY_CAPACITY = Math.ceil(HISTORY_SECONDS / SAMPLE_PERIOD);

const model = {
  mode: "traversal",
  running: false,
  paused: false,

  selectedConfig: "home",
  plot: "speed",
  selectedWheel: 0,

  waypoints: [],
  waypointIndex: 0,
  lookahead: 0.7,

  rover: {
    x: 1.0,
    y: 1.15,
    heading: degToRad(8),

    speed: 0,
    yawRate: 0,

    positionIntegral: 0,
    positionPrevError: 0,
    speedReference: 0,

    wheel: WHEEL_POSITIONS.map(() => ({
      angle: 0,
      rate: 0,
      integral: 0,
      prevError: 0,
      reference: 0,
    })),
  },

  history: {
    speedReference: [],
    speedActual: [],
    angleReference: [[], [], [], []],
    angleActual: [[], [], [], []],
  },

  lastTime: performance.now(),
  plotAccumulator: 0,
};

const gains = {
  steer: bindGains("steer"),
  drive: bindGains("drive"),
};

function bindGains(prefix) {
  const fields = ["kp", "ki", "kd"].map(
    (key) => document.querySelector(`#${prefix}-${key}`)
  );

  return {
    get kp() { return Number(fields[0].value) || 0; },
    get ki() { return Number(fields[1].value) || 0; },
    get kd() { return Number(fields[2].value) || 0; },
  };
}

function degToRad(value) {
  return (value * Math.PI) / 180;
}

function radToDeg(value) {
  return (value * 180) / Math.PI;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeAngle(angle) {
  let result = angle;

  while (result > Math.PI) result -= 2 * Math.PI;
  while (result < -Math.PI) result += 2 * Math.PI;

  return result;
}

function toSteeringRange(angle) {
  const wrapped = normalizeAngle(angle);

  if (wrapped > Math.PI / 2) return wrapped - Math.PI;
  if (wrapped < -Math.PI / 2) return wrapped + Math.PI;

  return wrapped;
}

function formatAngle(angle) {
  return `${radToDeg(angle).toFixed(1)}°`;
}

function initialise() {
  mapCanvas.addEventListener("pointerdown", addWaypoint);

  UI.traversalMode.addEventListener("click", () => switchMode("traversal"));
  UI.steeringMode.addEventListener("click", () => switchMode("steering"));

  UI.start.addEventListener("click", startTraversal);
  UI.pause.addEventListener("click", pauseTraversal);
  UI.reset.addEventListener("click", resetTraversal);

  UI.steeringPause.addEventListener("click", toggleSteeringPause);
  UI.steeringHome.addEventListener("click", () => chooseConfiguration("home"));

  UI.configurations.forEach((button) => {
    button.addEventListener("click", () => chooseConfiguration(button.dataset.config));
  });

  UI.graphButtons.forEach((button) => {
    button.addEventListener("click", () => changePlot(button.dataset.plot));
  });

  UI.wheelSelect.addEventListener("change", () => {
    model.selectedWheel = Number(UI.wheelSelect.value);
    clearHistory();
  });

  setConfiguration("home", true);
  refreshStatus();
  requestAnimationFrame(frame);
}

function switchMode(mode) {
  model.mode = mode;
  model.running = false;
  model.paused = false;

  UI.traversalMode.classList.toggle("active", mode === "traversal");
  UI.steeringMode.classList.toggle("active", mode === "steering");

  UI.traversalMode.setAttribute("aria-selected", String(mode === "traversal"));
  UI.steeringMode.setAttribute("aria-selected", String(mode === "steering"));

  UI.traversalActions.classList.toggle("is-hidden", mode !== "traversal");
  UI.steeringActions.classList.toggle("is-hidden", mode !== "steering");

  UI.mapFrame.classList.toggle("is-hidden", mode !== "traversal");
  UI.steeringFrame.classList.toggle("is-hidden", mode !== "steering");

  UI.driveController.classList.toggle("is-hidden", mode !== "traversal");
  UI.graphTabs.classList.toggle("is-hidden", mode !== "traversal");
  UI.wheelSelectLabel.classList.toggle("is-hidden", mode === "steering");

  UI.hint.textContent =
    mode === "traversal"
      ? "Click on the map to add waypoints. The rover follows them using four-wheel Ackermann steering."
      : "Press a configuration button. The wheel-angle setpoints change immediately and the PID drives each wheel there.";

  UI.message.textContent =
    mode === "traversal"
      ? "Add at least one waypoint, then press Start."
      : "Steering-only view: the chassis stays fixed while the four steering modules move.";

  if (mode === "steering") {
    changePlot("steer");
  }

  clearHistory();
  refreshStatus();
}

function startTraversal() {
  if (model.waypoints.length === 0) {
    UI.message.textContent = "Add a waypoint by clicking on the map first.";
    return;
  }

  model.running = true;
  model.paused = false;

  UI.message.textContent =
    "Following waypoints. Change either PID controller while the rover is moving.";

  refreshStatus();
}

function pauseTraversal() {
  if (!model.running) return;

  model.paused = !model.paused;
  UI.pause.textContent = model.paused ? "Resume" : "Pause";

  refreshStatus();
}

function resetTraversal() {
  model.running = false;
  model.paused = false;

  model.waypoints = [];
  model.waypointIndex = 0;

  model.rover.x = 1.0;
  model.rover.y = 1.15;
  model.rover.heading = degToRad(8);

  model.rover.speed = 0;
  model.rover.yawRate = 0;
  model.rover.positionIntegral = 0;
  model.rover.positionPrevError = 0;
  model.rover.speedReference = 0;

  resetWheelStates();

  UI.pause.textContent = "Pause";
  UI.message.textContent = "Map reset. Click to place a new waypoint path.";

  clearHistory();
  refreshStatus();
}

function toggleSteeringPause() {
  model.paused = !model.paused;

  UI.steeringPause.textContent = model.paused
    ? "Resume wheel motion"
    : "Pause wheel motion";

  refreshStatus();
}

function chooseConfiguration(name) {
  model.paused = false;
  UI.steeringPause.textContent = "Pause wheel motion";

  setConfiguration(name, false);
  model.selectedConfig = name;

  UI.configurations.forEach((button) => {
    button.classList.toggle("selected", button.dataset.config === name);
  });

  UI.configReadout.textContent = `${labelForConfig(name)} selected`;

  UI.message.textContent =
    `${labelForConfig(name)} target applied. Each wheel is moving from its present angle.`;

  refreshStatus();
}

function labelForConfig(name) {
  return {
    home: "Home",
    crab: "Crab",
    bishop: "Bishop",
    rotate: "Rotate-in-place",
  }[name];
}

function setConfiguration(name, immediate) {
  const reference = configurations()[name];

  model.rover.wheel.forEach((wheel, index) => {
    wheel.reference = reference[index];

    if (immediate) {
      wheel.angle = reference[index];
      wheel.rate = 0;
      wheel.integral = 0;
      wheel.prevError = 0;
    }
  });
}

function configurations() {
  const rotate = WHEEL_POSITIONS.map((position) => {
    return toSteeringRange(Math.atan2(position.x, -position.y));
  });

  return {
    home: [0, 0, 0, 0],
    crab: [MAX_STEER, MAX_STEER, MAX_STEER, MAX_STEER],
    bishop: [degToRad(45), degToRad(45), degToRad(45), degToRad(45)],
    rotate,
  };
}

function resetWheelStates() {
  model.rover.wheel.forEach((wheel) => {
    Object.assign(wheel, {
      angle: 0,
      rate: 0,
      integral: 0,
      prevError: 0,
      reference: 0,
    });
  });
}

function addWaypoint(event) {
  if (model.mode !== "traversal") return;

  const bounds = mapCanvas.getBoundingClientRect();

  const xPixels =
    ((event.clientX - bounds.left) * mapCanvas.width) / bounds.width;

  const yPixels =
    ((event.clientY - bounds.top) * mapCanvas.height) / bounds.height;

  const point = {
    x: xPixels / MAP.pixelsPerMetre,
    y: MAP.height - yPixels / MAP.pixelsPerMetre,
  };

  if (
    point.x < 0.15 ||
    point.x > MAP.width - 0.15 ||
    point.y < 0.15 ||
    point.y > MAP.height - 0.15
  ) {
    return;
  }

  model.waypoints.push(point);

  UI.message.textContent =
    `${model.waypoints.length} waypoint${model.waypoints.length === 1 ? "" : "s"} placed. Add more or press Start.`;

  refreshStatus();
}

function changePlot(plot) {
  model.plot = plot;

  UI.graphButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.plot === plot);
  });

  UI.graphTitle.textContent =
    plot === "speed"
      ? "Speed response"
      : `${WHEEL_NAMES[model.selectedWheel]} steering response`;

  clearHistory();
}

function updateTraversal(dt) {
  const rover = model.rover;

  if (model.paused) return;

  if (!model.running || model.waypoints.length === 0) {
    updateDrive(dt, 0, 0);

    rover.wheel.forEach((wheel) => {
      wheel.reference = 0;
    });

    updateAllSteering(dt);
    return;
  }

  const target = model.waypoints[model.waypointIndex];

  if (!target) {
    model.running = false;
    UI.message.textContent = "Path complete.";
    refreshStatus();
    return;
  }

  const dx = target.x - rover.x;
  const dy = target.y - rover.y;

  /* e_p = ||p_goal - p_rover|| */
  const distanceError = Math.hypot(dx, dy);

  if (distanceError < 0.22) {
    model.waypointIndex += 1;

    if (model.waypointIndex >= model.waypoints.length) {
      model.running = false;
      rover.speedReference = 0;
      UI.message.textContent = "Final waypoint reached.";
      refreshStatus();
    }

    return;
  }

  const desiredHeading = Math.atan2(dy, dx);
  const headingError = normalizeAngle(desiredHeading - rover.heading);

  const lookahead = clamp(
    Math.max(distanceError, model.lookahead),
    model.lookahead,
    1.5,
  );

  const curvature = clamp(
    (2 * Math.sin(headingError)) / lookahead,
    -1.8,
    1.8,
  );

  updateDrive(dt, distanceError, curvature);
  setAckermannReferences(curvature, rover.speedReference);

  updateAllSteering(dt);
  updateRoverPose(dt);
}

function updateSteeringMode(dt) {
  const rover = model.rover;

  rover.speedReference = 0;
  rover.speed = 0;
  rover.yawRate = 0;

  if (!model.paused) {
    updateAllSteering(dt);
  }
}

function setAckermannReferences(curvature, forwardSpeed) {
  /*
    For each wheel:

    v_wheel = [v - omega*y_i, omega*x_i]
    omega = v*curvature

    Wheel reference = atan2(lateral component, longitudinal component)
  */
  const yawReference = forwardSpeed * curvature;

  model.rover.wheel.forEach((wheel, index) => {
    const position = WHEEL_POSITIONS[index];

    const longitudinal = forwardSpeed - yawReference * position.y;
    const lateral = yawReference * position.x;

    wheel.reference = clamp(
      Math.atan2(lateral, longitudinal),
      -MAX_STEER,
      MAX_STEER,
    );
  });
}

function updateAllSteering(dt) {
  model.rover.wheel.forEach((wheel) => {
    updateSteeringWheel(wheel, dt);
  });
}

function updateSteeringWheel(wheel, dt) {
  const error = normalizeAngle(wheel.reference - wheel.angle);
  const derivative = (error - wheel.prevError) / dt;

  const candidateIntegral = clamp(
    wheel.integral + error * dt,
    -0.9,
    0.9,
  );

  const rawCommand =
    gains.steer.kp * error +
    gains.steer.ki * candidateIntegral +
    gains.steer.kd * derivative;

  const command = clamp(
    rawCommand,
    -MAX_STEER_COMMAND,
    MAX_STEER_COMMAND,
  );

  const saturated = Math.abs(rawCommand - command) > 1e-8;

  if (!saturated || Math.sign(rawCommand) !== Math.sign(error)) {
    wheel.integral = candidateIntegral;
  }

  /*
    d(omega)/dt = (1.65*u - omega)/0.115
    d(theta)/dt = omega
  */
  wheel.rate += ((1.65 * command) - wheel.rate) * dt / 0.115;
  wheel.angle += wheel.rate * dt;

  if (wheel.angle > MAX_STEER || wheel.angle < -MAX_STEER) {
    wheel.angle = clamp(wheel.angle, -MAX_STEER, MAX_STEER);
    wheel.rate = 0;
  }

  wheel.prevError = error;
}

function updateDrive(dt, positionError, curvature) {
  const rover = model.rover;

  const derivative =
    (positionError - rover.positionPrevError) / dt;

  const candidateIntegral = clamp(
    rover.positionIntegral + positionError * dt,
    -1.2,
    1.2,
  );

  /*
    PID output is the velocity reference:

    v_ref = Kp*e_p + Ki*integral(e_p) + Kd*de_p/dt
  */
  const rawSpeedReference =
    gains.drive.kp * positionError +
    gains.drive.ki * candidateIntegral +
    gains.drive.kd * derivative;

  /*
    Slow down while making a sharper turn.
    This does not replace the PID; it is a trajectory-safety scale.
  */
  const cornerScale =
    1 - 0.36 * Math.min(1, Math.abs(curvature) / 1.8);

  const speedReference = clamp(
    rawSpeedReference * cornerScale,
    0,
    MAX_SPEED,
  );

  const saturated =
    Math.abs(rawSpeedReference * cornerScale - speedReference) > 1e-8;

  if (!saturated || Math.sign(rawSpeedReference) !== Math.sign(positionError)) {
    rover.positionIntegral = candidateIntegral;
  }

  rover.speedReference = speedReference;

  /*
    First-order drive plant:
    dv/dt = (v_ref - v)/0.24
  */
  rover.speed += (rover.speedReference - rover.speed) * dt / 0.24;
  rover.speed = clamp(rover.speed, 0, 1.22);

  rover.positionPrevError = positionError;
}

function updateRoverPose(dt) {
  const rover = model.rover;

  const frontAverage =
    (rover.wheel[0].angle + rover.wheel[1].angle) / 2;

  const rearAverage =
    (rover.wheel[2].angle + rover.wheel[3].angle) / 2;

  const curvatureActual = clamp(
    (Math.tan(frontAverage) - Math.tan(rearAverage)) / WHEEL_BASE,
    -2.2,
    2.2,
  );

  rover.yawRate = rover.speed * curvatureActual;

  rover.heading = normalizeAngle(
    rover.heading + rover.yawRate * dt,
  );

  rover.x += rover.speed * Math.cos(rover.heading) * dt;
  rover.y += rover.speed * Math.sin(rover.heading) * dt;

  rover.x = clamp(rover.x, 0.12, MAP.width - 0.12);
  rover.y = clamp(rover.y, 0.12, MAP.height - 0.12);
}

function sampleHistory() {
  const rover = model.rover;

  pushHistory(model.history.speedReference, rover.speedReference);
  pushHistory(model.history.speedActual, rover.speed);

  rover.wheel.forEach((wheel, index) => {
    pushHistory(
      model.history.angleReference[index],
      radToDeg(wheel.reference),
    );

    pushHistory(
      model.history.angleActual[index],
      radToDeg(wheel.angle),
    );
  });
}

function pushHistory(history, value) {
  history.push(value);

  if (history.length > HISTORY_CAPACITY) {
    history.shift();
  }
}

function clearHistory() {
  model.history = {
    speedReference: [],
    speedActual: [],
    angleReference: [[], [], [], []],
    angleActual: [[], [], [], []],
  };

  model.plotAccumulator = 0;
}

function frame(now) {
  const dt = Math.min(
    0.04,
    Math.max(0.004, (now - model.lastTime) / 1000),
  );

  model.lastTime = now;

  if (model.mode === "traversal") {
    updateTraversal(dt);
  } else {
    updateSteeringMode(dt);
  }

  model.plotAccumulator += dt;

  if (model.plotAccumulator >= SAMPLE_PERIOD) {
    sampleHistory();
    model.plotAccumulator = 0;
  }

  renderScene();
  renderPlot();
  refreshTelemetry();

  requestAnimationFrame(frame);
}

function renderScene() {
  if (model.mode === "steering") {
    renderSteeringView();
    return;
  }

  mapCtx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);

  drawMapGrid(mapCtx);
  drawPath(mapCtx);
  drawMapRover(mapCtx);
}

function renderSteeringView() {
  const rover = model.rover;
  const scale = 255;

  const length = WHEEL_BASE * scale;
  const width = 0.95 * scale;

  steeringCtx.clearRect(0, 0, steeringCanvas.width, steeringCanvas.height);

  steeringCtx.fillStyle = "#e8e6df";
  steeringCtx.fillRect(0, 0, steeringCanvas.width, steeringCanvas.height);

  steeringCtx.strokeStyle = "#c9cfcd";
  steeringCtx.setLineDash([7, 7]);
  steeringCtx.beginPath();
  steeringCtx.moveTo(0, steeringCanvas.height / 2);
  steeringCtx.lineTo(steeringCanvas.width, steeringCanvas.height / 2);
  steeringCtx.stroke();
  steeringCtx.setLineDash([]);

  steeringCtx.save();
  steeringCtx.translate(
    steeringCanvas.width / 2,
    steeringCanvas.height / 2,
  );

  steeringCtx.fillStyle = "#f7f8f6";
  steeringCtx.strokeStyle = "#1f2d33";
  steeringCtx.lineWidth = 3;

  steeringCtx.fillRect(-length / 2, -width / 2, length, width);
  steeringCtx.strokeRect(-length / 2, -width / 2, length, width);

  steeringCtx.fillStyle = "#075966";
  steeringCtx.fillRect(length / 2 - 16, -width / 2 + 12, 16, width - 24);

  steeringCtx.fillStyle = "#1f2d33";
  steeringCtx.font = "700 16px system-ui";
  steeringCtx.fillText("FRONT", length / 2 - 73, 6);

  WHEEL_POSITIONS.forEach((position, index) => {
    drawZoomedWheel(
      steeringCtx,
      position,
      rover.wheel[index].angle,
      index,
      scale,
    );
  });

  steeringCtx.restore();
}

function drawZoomedWheel(ctx, position, steeringAngle, index, scale) {
  const x = position.x * scale;
  const y = -position.y * scale;

  const wheelLength = 0.36 * scale;
  const wheelWidth = 0.18 * scale;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-steeringAngle);

  ctx.fillStyle = "#263c43";
  roundedRect(
    ctx,
    -wheelLength / 2,
    -wheelWidth / 2,
    wheelLength,
    wheelWidth,
    8,
  );
  ctx.fill();

  ctx.strokeStyle = "#f4f2ed";
  ctx.lineWidth = 2;
  ctx.beginPath();

  [-0.25, 0, 0.25].forEach((fraction) => {
    const tread = fraction * wheelLength;
    ctx.moveTo(tread, -wheelWidth * 0.28);
    ctx.lineTo(tread, wheelWidth * 0.28);
  });

  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = "#1f2d33";
  ctx.font = "700 14px system-ui";
  ctx.fillText(
    `${WHEEL_TAGS[index]}  ${formatAngle(steeringAngle)}`,
    x - 38,
    y - wheelWidth / 2 - 16,
  );
}

function drawMapGrid(ctx) {
  ctx.fillStyle = "#e7ebe8";
  ctx.fillRect(0, 0, mapCanvas.width, mapCanvas.height);

  ctx.strokeStyle = "#d0d8d4";
  ctx.lineWidth = 1;

  for (let x = 0; x <= mapCanvas.width; x += 50) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, mapCanvas.height);
    ctx.stroke();
  }

  for (let y = 0; y <= mapCanvas.height; y += 50) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(mapCanvas.width, y);
    ctx.stroke();
  }

  ctx.strokeStyle = "#b6c3be";
  ctx.lineWidth = 1.2;
  ctx.strokeRect(10, 10, mapCanvas.width - 20, mapCanvas.height - 20);
}

function worldToCanvas(point) {
  return {
    x: point.x * MAP.pixelsPerMetre,
    y: mapCanvas.height - point.y * MAP.pixelsPerMetre,
  };
}

function drawPath(ctx) {
  const roverPoint = worldToCanvas(model.rover);

  if (model.waypoints.length > 0) {
    ctx.save();

    ctx.strokeStyle = "#b84a37";
    ctx.setLineDash([8, 7]);
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.moveTo(roverPoint.x, roverPoint.y);

    model.waypoints.forEach((waypoint) => {
      const point = worldToCanvas(waypoint);
      ctx.lineTo(point.x, point.y);
    });

    ctx.stroke();
    ctx.restore();
  }

  model.waypoints.forEach((waypoint, index) => {
    const point = worldToCanvas(waypoint);

    const active =
      index === model.waypointIndex && model.running;

    ctx.fillStyle = active ? "#075966" : "#b84a37";

    ctx.beginPath();
    ctx.arc(point.x, point.y, active ? 8 : 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#1f2d33";
    ctx.font = "700 12px system-ui";
    ctx.fillText(String(index + 1), point.x + 10, point.y - 8);
  });
}

function drawMapRover(ctx) {
  const rover = model.rover;
  const centre = worldToCanvas(rover);

  const scale = MAP.pixelsPerMetre;
  const length = WHEEL_BASE * scale;
  const width = 0.95 * scale;

  ctx.save();
  ctx.translate(centre.x, centre.y);
  ctx.rotate(-rover.heading);

  ctx.fillStyle = "#f7f8f6";
  ctx.strokeStyle = "#1f2d33";
  ctx.lineWidth = 2.2;

  ctx.fillRect(-length / 2, -width / 2, length, width);
  ctx.strokeRect(-length / 2, -width / 2, length, width);

  ctx.fillStyle = "#075966";
  ctx.fillRect(length / 2 - 9, -width / 2 + 7, 9, width - 14);

  ctx.fillStyle = "#1f2d33";
  ctx.font = "700 11px system-ui";
  ctx.fillText("FRONT", length / 2 - 49, 4);

  WHEEL_POSITIONS.forEach((position, index) => {
    drawMapWheel(ctx, position, rover.wheel[index].angle, index);
  });

  ctx.restore();
}

function drawMapWheel(ctx, position, steeringAngle, index) {
  const scale = MAP.pixelsPerMetre;

  const x = position.x * scale;
  const y = -position.y * scale;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-steeringAngle);

  ctx.fillStyle = "#263c43";
  roundedRect(ctx, -18, -9, 36, 18, 4);
  ctx.fill();

  ctx.strokeStyle = "#f4f2ed";
  ctx.lineWidth = 1;
  ctx.beginPath();

  [-10, 0, 10].forEach((tread) => {
    ctx.moveTo(tread, -5);
    ctx.lineTo(tread, 5);
  });

  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.translate(x, y);

  ctx.fillStyle = "#1f2d33";
  ctx.font = "700 10px system-ui";
  ctx.fillText(WHEEL_TAGS[index], -9, -18);

  ctx.restore();
}

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();

  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);

  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(
    x + width,
    y + height,
    x + width - radius,
    y + height,
  );

  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);

  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);

  ctx.closePath();
}

function renderPlot() {
  const ctx = plotCtx;
  const canvas = plotCanvas;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const pad = {
    left: 46,
    right: 10,
    top: 12,
    bottom: 27,
  };

  const plotWidth = canvas.width - pad.left - pad.right;
  const plotHeight = canvas.height - pad.top - pad.bottom;

  const data = plotData();

  const values = [
    ...data.reference,
    ...data.actual,
    data.min,
    data.max,
  ];

  let min = Math.min(...values);
  let max = Math.max(...values);

  if (Math.abs(max - min) < 0.25) {
    min -= 0.5;
    max += 0.5;
  }

  const margin = (max - min) * 0.12;
  min -= margin;
  max += margin;

  const yFor = (value) => {
    return pad.top + ((max - value) / (max - min)) * plotHeight;
  };

  const xFor = (index, length) => {
    return pad.left +
      (length < 2 ? 0 : (index / (length - 1)) * plotWidth);
  };

  ctx.fillStyle = "#fbfaf7";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "#d9dedb";
  ctx.fillStyle = "#5d6a6d";
  ctx.lineWidth = 1;
  ctx.font = "11px system-ui";

  for (let index = 0; index <= 4; index += 1) {
    const value = min + ((max - min) * index) / 4;
    const y = yFor(value);

    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(canvas.width - pad.right, y);
    ctx.stroke();

    ctx.fillText(
      value.toFixed(data.unit === "m/s" ? 2 : 0),
      3,
      y + 4,
    );
  }

  ctx.strokeStyle = "#879592";

  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top);
  ctx.lineTo(pad.left, canvas.height - pad.bottom);
  ctx.lineTo(canvas.width - pad.right, canvas.height - pad.bottom);
  ctx.stroke();

  ctx.fillStyle = "#5d6a6d";
  ctx.fillText(
    `10 s window · ${data.unit}`,
    canvas.width - 114,
    canvas.height - 8,
  );

  drawTrace(ctx, data.reference, xFor, yFor, "#b84a37", [7, 5]);
  drawTrace(ctx, data.actual, xFor, yFor, "#075966", []);
}

function plotData() {
  if (model.plot === "speed") {
    return {
      reference: model.history.speedReference,
      actual: model.history.speedActual,
      unit: "m/s",
      min: 0,
      max: MAX_SPEED,
    };
  }

  const index = model.selectedWheel;

  return {
    reference: model.history.angleReference[index],
    actual: model.history.angleActual[index],
    unit: "deg",
    min: -90,
    max: 90,
  };
}

function drawTrace(ctx, data, xFor, yFor, colour, dash) {
  if (data.length < 2) return;

  ctx.save();

  ctx.strokeStyle = colour;
  ctx.lineWidth = 2.2;
  ctx.setLineDash(dash);

  ctx.beginPath();

  data.forEach((value, index) => {
    const x = xFor(index, data.length);
    const y = yFor(value);

    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  ctx.stroke();
  ctx.restore();
}

function refreshTelemetry() {
  const rover = model.rover;

  const target =
    model.mode === "traversal"
      ? model.waypoints[model.waypointIndex]
      : null;

  UI.speed.textContent = `${rover.speed.toFixed(2)} m/s`;

  UI.heading.textContent =
    `${radToDeg(normalizeAngle(rover.heading)).toFixed(1)}°`;

  UI.target.textContent = target
    ? `${model.waypointIndex + 1} / ${model.waypoints.length}`
    : model.mode === "steering"
      ? labelForConfig(model.selectedConfig)
      : "—";

  UI.angle.textContent =
    `${WHEEL_NAMES[model.selectedWheel]}: ${formatAngle(rover.wheel[model.selectedWheel].angle)}`;

  UI.graphTitle.textContent =
    model.plot === "speed"
      ? "Speed response"
      : `${WHEEL_NAMES[model.selectedWheel]} steering response`;

  updateControllerSummary(UI.steerSummary, gains.steer);
  updateControllerSummary(UI.driveSummary, gains.drive);
}

function updateControllerSummary(element, controller) {
  if (controller.ki === 0 && controller.kd === 0) {
    element.value = "P only";
  } else if (controller.ki === 0) {
    element.value = "PD";
  } else if (controller.kd === 0) {
    element.value = "PI";
  } else {
    element.value = "PID";
  }
}

function refreshStatus() {
  const steeringMoving = model.rover.wheel.some((wheel) => {
    return (
      Math.abs(wheel.reference - wheel.angle) > degToRad(0.25) ||
      Math.abs(wheel.rate) > degToRad(0.25)
    );
  });

  const active =
    model.mode === "traversal"
      ? model.running && !model.paused
      : !model.paused && steeringMoving;

  UI.runDot.classList.toggle("running", active);

  UI.runState.textContent = model.paused
    ? "Paused"
    : active
      ? "Running"
      : "Ready";

  UI.waypointReadout.textContent =
    `${model.waypoints.length} waypoint${model.waypoints.length === 1 ? "" : "s"}`;
}

initialise();