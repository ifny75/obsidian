'use client';

import { useEffect, useRef } from 'react';

const VERTEX_SHADER = `
attribute vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
`;

const FRAGMENT_SHADER = `
precision highp float;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 5; i++) {
    value += amplitude * noise(p);
    p = p * 2.03 + 0.17;
    amplitude *= 0.5;
  }
  return value;
}

float ribbon(vec2 p, float offset, float frequency, float amplitude, float speed, float width, float phase) {
  float wave = offset
    + sin(p.x * frequency + u_time * speed + phase) * amplitude
    + (fbm(vec2(p.x * 1.45 + u_time * speed * 0.12, phase)) - 0.5) * amplitude * 0.9;
  float distanceToRibbon = abs(p.y - wave);
  float core = smoothstep(width, width * 0.08, distanceToRibbon);
  float halo = smoothstep(width * 3.2, 0.0, distanceToRibbon) * 0.34;
  return core + halo;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  vec2 p = uv - 0.5;
  p.x *= u_resolution.x / u_resolution.y;
  p *= mat2(cos(0.52 + u_seed * 0.08), -sin(0.52 + u_seed * 0.08), sin(0.52 + u_seed * 0.08), cos(0.52 + u_seed * 0.08));

  float cloud = fbm(p * 2.4 + vec2(u_time * 0.025, u_seed));
  float glow = smoothstep(0.95, 0.0, length(p - vec2(0.12, -0.08)));
  vec3 color = mix(vec3(0.004, 0.002, 0.008), vec3(0.11, 0.0, 0.22), cloud * 0.72 + glow * 0.28);

  float r1 = ribbon(p, 0.13, 3.2, 0.19, 0.28, 0.042, u_seed);
  float r2 = ribbon(p, -0.08, 2.5, 0.23, -0.22, 0.033, 2.2 + u_seed);
  float r3 = ribbon(p, -0.26, 3.8, 0.12, 0.18, 0.022, 4.7 + u_seed);
  color += vec3(0.80, 0.04, 1.0) * r1;
  color += vec3(0.35, 0.0, 0.93) * r2;
  color += vec3(0.95, 0.21, 1.0) * r3 * 0.78;

  float grain = (hash(gl_FragCoord.xy + u_seed) - 0.5) * 0.045;
  color += grain;
  float vignette = smoothstep(0.78, 0.22, length(uv - 0.5));
  color *= mix(0.66, 1.0, vignette);
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function RibbonShader({ seed }: { seed: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', { alpha: false, antialias: true, powerPreference: 'low-power' });
    if (!gl) return;

    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vertex || !fragment) return;
    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const resolution = gl.getUniformLocation(program, 'u_resolution');
    const time = gl.getUniformLocation(program, 'u_time');
    const seedLocation = gl.getUniformLocation(program, 'u_seed');
    const started = performance.now();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;
    let visible = true;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
    };

    const draw = (now: number) => {
      resize();
      gl.uniform2f(resolution, canvas.width, canvas.height);
      gl.uniform1f(time, reducedMotion ? 0 : (now - started) / 1000);
      gl.uniform1f(seedLocation, seed);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (!reducedMotion && visible) frame = requestAnimationFrame(draw);
    };

    const observer = new IntersectionObserver(([entry]) => {
      const nextVisible = entry.isIntersecting;
      if (nextVisible && !visible && !reducedMotion) frame = requestAnimationFrame(draw);
      visible = nextVisible;
      if (!visible) cancelAnimationFrame(frame);
    });
    observer.observe(canvas);
    frame = requestAnimationFrame(draw);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
    };
  }, [seed]);

  return <canvas ref={canvasRef} className="ribbon-canvas" aria-hidden="true" />;
}
