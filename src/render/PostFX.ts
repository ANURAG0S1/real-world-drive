import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

export type PostFXLevel = 'off' | 'basic' | 'full';

/**
 * Filmic grade applied after tone mapping, in display space: a gentle S-curve,
 * split toning (cool shadows, warm highlights), a touch of saturation, lens
 * vignette, faint chromatic fringing toward the edges and animated grain.
 */
const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    time: { value: 0 },
    resolution: { value: new THREE.Vector2(1, 1) },
    contrast: { value: 1.12 },
    saturation: { value: 1.14 },
    vignette: { value: 0.32 },
    grain: { value: 0.022 },
    fringe: { value: 0.006 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform vec2 resolution;
    uniform float contrast;
    uniform float saturation;
    uniform float vignette;
    uniform float grain;
    uniform float fringe;
    varying vec2 vUv;

    float hash(vec2 p) {
      p = fract(p * vec2(443.897, 441.423));
      p += dot(p, p.yx + 19.19);
      return fract((p.x + p.y) * p.x);
    }

    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      // Lateral chromatic aberration grows with the square of the distance from centre.
      vec2 off = c * r2 * fringe;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv - off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv + off).b;

      // S-curve around mid grey.
      col = clamp((col - 0.5) * contrast + 0.5, 0.0, 1.0);
      col = col * col * (3.0 - 2.0 * col) * 0.25 + col * 0.75;

      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, saturation);
      // Split toning: teal in the shadows, amber in the highlights.
      vec3 shadowTint = vec3(-0.012, 0.004, 0.018);
      vec3 highTint = vec3(0.022, 0.010, -0.016);
      col += shadowTint * (1.0 - smoothstep(0.0, 0.45, luma)) + highTint * smoothstep(0.55, 1.0, luma);

      // Optical vignette.
      float v = 1.0 - vignette * smoothstep(0.08, 0.62, r2 * 1.6);
      col *= v;

      // Luma-weighted grain, strongest in the mid-tones like film.
      float n = hash(vUv * resolution + fract(time) * 1000.0) - 0.5;
      col += n * grain * (1.0 - abs(luma - 0.5) * 1.2);

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `,
};

/**
 * Post-processing chain for the driving view:
 * scene (4x MSAA, half-float HDR) -> GTAO ambient occlusion -> bloom -> tone
 * mapping and sRGB -> filmic grade. 'off' renders straight to the screen.
 */
export class PostFX {
  private readonly composer: EffectComposer | null = null;
  private readonly gtao: GTAOPass | null = null;
  private readonly bloom: UnrealBloomPass | null = null;
  private readonly grade: ShaderPass | null = null;
  private time = 0;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    readonly level: PostFXLevel,
    /** Ambient occlusion resolution relative to the screen; half is ~4x cheaper and looks nearly the same. */
    private readonly aoScale = 1,
  ) {
    if (level === 'off') return;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: level === 'full' ? 4 : 2,
    });
    const composer = new EffectComposer(renderer, target);
    composer.addPass(new RenderPass(scene, camera));

    if (level === 'full') {
      const gtao = new GTAOPass(scene, camera, Math.round(size.x * aoScale), Math.round(size.y * aoScale));
      const samples = aoScale < 1 ? 8 : 12;
      gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.6, thickness: 1.2, scale: 1.0, samples, distanceFallOff: 1 });
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples });
      gtao.blendIntensity = 0.85;
      composer.addPass(gtao);
      this.gtao = gtao;
    }

    // Only genuinely bright pixels (lamps, sun glints on paint and glass) bloom.
    const bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.2, 0.4, 3.0);
    composer.addPass(bloom);
    this.bloom = bloom;

    composer.addPass(new OutputPass());
    const grade = new ShaderPass(GradeShader);
    grade.uniforms.resolution.value.set(size.x, size.y);
    if (level === 'basic') {
      grade.uniforms.fringe.value = 0;
      grade.uniforms.grain.value = 0.014;
    }
    composer.addPass(grade);
    this.grade = grade;
    this.composer = composer;
  }

  render(dt: number): void {
    if (!this.composer) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.time += dt;
    if (this.grade) this.grade.uniforms.time.value = this.time;
    this.composer.render(dt);
  }

  /** Width and height in CSS pixels; the composer applies the renderer's pixel ratio. */
  setSize(width: number, height: number): void {
    if (!this.composer) return;
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(width, height);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    // The composer already resized every pass (bloom halves its own buffers); AO runs reduced.
    this.grade?.uniforms.resolution.value.set(size.x, size.y);
    this.gtao?.setSize(Math.round(size.x * this.aoScale), Math.round(size.y * this.aoScale));
  }

  dispose(): void {
    this.gtao?.dispose();
    this.bloom?.dispose();
    this.composer?.dispose();
  }
}
