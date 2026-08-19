/**
 * Clean Line-Art Car Animation Engine for FinChat
 * Removed all broken/dashed background lines per user request.
 * Renders a single clean solid ground line and solid 4x4 Off-Roader vehicle.
 */

window.CarRoadAnim = (function () {

  class SleekOffRoaderCarInstance {
    constructor(containerEl, userText = '', personaName = 'Plato') {
      this.container = containerEl;
      this.userText = userText;
      this.animId = null;
      this.isDestroyed = false;

      // Determine prompt complexity & token estimate
      this.tokensEstimate = this.estimateTokens(userText);
      this.isComplex = this.tokensEstimate > 200 || /think harder|ultrathink|megathink|deeply|analyze|compare|risk|crypto|decentralized|portfolio|yield/i.test(userText);

      // ALWAYS climb UPWARDS to the top-right during thinking:
      // Complex prompt => steep hill climb (+0.40 rad / ~23 degrees)
      // Standard prompt => smooth hill climb (+0.20 rad / ~11.5 degrees)
      this.targetSlopeAngle = this.isComplex ? 0.40 : 0.20;
      this.currentSlopeAngle = 0; // Smooth transition

      this.speed = 4.8;
      this.distance = 0;

      this.carX = 75; // Fixed horizontal position
      this.wheelBase = 26;
      this.wheelsRotation = 0;
      this.smokeParticles = [];

      this.initUI();
      this.initCanvas();
    }

    estimateTokens(text) {
      if (!text) return 150;
      const charLen = text.length;
      const wordCount = text.trim().split(/\s+/).length;
      const isTengu = /think harder|ultrathink|megathink|deeply/i.test(text);
      let est = Math.round(wordCount * 1.35 + charLen * 0.2);
      if (isTengu) est += 800;
      return Math.max(80, est);
    }

    initUI() {
      this.container.innerHTML = `
        <div class="minimal-car-wrapper">
          <canvas class="minimal-car-canvas"></canvas>
        </div>
      `;

      this.canvas = this.container.querySelector('.minimal-car-canvas');
      this.ctx = this.canvas.getContext('2d');
    }

    initCanvas() {
      this.onResize = () => {
        if (!this.canvas) return;
        const rect = this.canvas.parentNode.getBoundingClientRect();
        this.width = rect.width || 380;
        this.height = 75;
        this.canvas.width = this.width * (window.devicePixelRatio || 1);
        this.canvas.height = this.height * (window.devicePixelRatio || 1);
        this.canvas.style.width = this.width + 'px';
        this.canvas.style.height = this.height + 'px';
        this.ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
      };

      this.onResize();
      window.addEventListener('resize', this.onResize);
      this.animate();
    }

    // Ground elevation function:
    getGroundY(screenX) {
      const baseY = this.height - 22;
      const slopeOffsetY = (screenX - this.carX) * Math.tan(this.currentSlopeAngle);
      const ripple = Math.sin((this.distance + screenX) * 0.032) * 3.5;
      return baseY - slopeOffsetY - ripple;
    }

    animate() {
      if (this.isDestroyed) return;
      this.animId = requestAnimationFrame(() => this.animate());

      // Interpolate slope angle towards target
      this.currentSlopeAngle += (this.targetSlopeAngle - this.currentSlopeAngle) * 0.05;

      this.distance += this.speed;
      this.wheelsRotation += this.speed * 0.20;

      const ctx = this.ctx;
      const w = this.width;
      const h = this.height;

      // Clear canvas (transparent)
      ctx.clearRect(0, 0, w, h);

      const strokeColor = '#3a2e23';

      // 1. Draw Main Uphill Road Ground Line ONLY (Single solid clean stroke, NO dashed/broken lines)
      ctx.save();
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      ctx.beginPath();
      for (let screenX = 0; screenX <= w; screenX += 3) {
        const groundY = this.getGroundY(screenX);
        if (screenX === 0) ctx.moveTo(0, groundY);
        else ctx.lineTo(screenX, groundY);
      }
      ctx.stroke();
      ctx.restore();

      // 2. Calculate Car Position & Pitch Angle on Ground Slope
      const rearWheelX = this.carX - this.wheelBase / 2;
      const frontWheelX = this.carX + this.wheelBase / 2;

      const rearY = this.getGroundY(rearWheelX);
      const frontY = this.getGroundY(frontWheelX);

      const dx = this.wheelBase;
      const dy = frontY - rearY;
      const pitchAngle = Math.atan2(dy, dx); // Tilts car UP to the right

      const carCenterY = (rearY + frontY) / 2 - 9;

      // 3. Exhaust Smoke Particles
      if (Math.random() < 0.35) {
        this.smokeParticles.push({
          x: this.carX - 22,
          y: carCenterY + 2,
          r: 1.5 + Math.random() * 2,
          alpha: 0.6
        });
      }

      for (let i = this.smokeParticles.length - 1; i >= 0; i--) {
        const p = this.smokeParticles[i];
        p.x -= 1.8;
        p.y -= 0.3;
        p.r += 0.15;
        p.alpha -= 0.04;

        if (p.alpha <= 0) {
          this.smokeParticles.splice(i, 1);
          continue;
        }

        ctx.save();
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(90, 70, 53, ${p.alpha})`;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.restore();
      }

      // 4. Draw Solid 4x4 Off-Roader Vehicle Body Line Art
      ctx.save();
      ctx.translate(this.carX, carCenterY);
      ctx.rotate(pitchAngle);

      ctx.strokeStyle = strokeColor;
      ctx.fillStyle = strokeColor;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // Roll Bar / Roof Rack
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(-10, -14); ctx.lineTo(-10, -17); ctx.lineTo(3, -17); ctx.lineTo(3, -14);
      ctx.stroke();

      // Main Car Body Outline & Fill (Solid cream fill prevents road bleed-through)
      ctx.beginPath();
      ctx.moveTo(-20, -2);
      ctx.lineTo(-20, -9);
      ctx.lineTo(-12, -14); // Slanting rear roof
      ctx.lineTo(2, -14);   // Roof top
      ctx.lineTo(10, -8);   // Windshield slant
      ctx.lineTo(18, -8);   // Front hood
      ctx.lineTo(18, -2);   // Front grille
      ctx.arc(10, -2, 6.5, 0, Math.PI, true);
      ctx.lineTo(-3.5, -2);
      ctx.arc(-10, -2, 6.5, 0, Math.PI, true);
      ctx.lineTo(-20, -2);
      ctx.closePath();

      // Cream fill to mask out road behind body
      ctx.fillStyle = '#fffaf0';
      ctx.fill();

      // Solid stroke outline
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2.4;
      ctx.stroke();

      // Cabin Window Glass Cutout
      ctx.beginPath();
      ctx.moveTo(-10, -12);
      ctx.lineTo(0, -12);
      ctx.lineTo(7, -8);
      ctx.lineTo(-10, -8);
      ctx.closePath();
      ctx.fillStyle = '#fffaf0';
      ctx.fill();
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 1.8;
      ctx.stroke();

      // Rear Mounted Spare Wheel
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(-22, -7, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fffaf0';
      ctx.fill();
      ctx.stroke();

      // Headlight Beam Cone
      ctx.save();
      ctx.fillStyle = 'rgba(198, 113, 57, 0.15)';
      ctx.beginPath();
      ctx.moveTo(18, -6);
      ctx.lineTo(36, -11);
      ctx.lineTo(36, 4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      ctx.lineWidth = 1.6;
      ctx.strokeStyle = '#c67139'; // Terracotta headlight beam line
      ctx.beginPath();
      ctx.moveTo(18, -6);
      ctx.lineTo(30, -6);
      ctx.stroke();

      // Chunky Off-Road Wheels with Cream Fill & Solid Spokes
      const drawOffroadWheel = (wx, wy) => {
        ctx.save();
        ctx.translate(wx, wy);

        // Wheel Background Mask
        ctx.beginPath();
        ctx.arc(0, 0, 6.5, 0, Math.PI * 2);
        ctx.fillStyle = '#fffaf0';
        ctx.fill();

        // Outer Tire Circle
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 2.4;
        ctx.stroke();

        // Inner Wheel Hub
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(0, 0, 3.0, 0, Math.PI * 2);
        ctx.stroke();

        // Rotating Spoke Treads
        ctx.rotate(this.wheelsRotation);
        ctx.lineWidth = 1.4;
        for (let a = 0; a < Math.PI * 2; a += Math.PI / 3) {
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * 3.0, Math.sin(a) * 3.0);
          ctx.lineTo(Math.cos(a) * 6.5, Math.sin(a) * 6.5);
          ctx.stroke();
        }

        ctx.restore();
      };

      drawOffroadWheel(-10, 2); // Rear wheel
      drawOffroadWheel(10, 2);  // Front wheel

      ctx.restore();
    }

    setPhrase(text) {
      // Hidden
    }

    destroy() {
      this.isDestroyed = true;
      if (this.animId) cancelAnimationFrame(this.animId);
      if (this.onResize) window.removeEventListener('resize', this.onResize);
      this.container.innerHTML = '';
    }
  }

  return {
    mount: function (containerEl, userText, personaName) {
      return new SleekOffRoaderCarInstance(containerEl, userText, personaName);
    }
  };
})();
