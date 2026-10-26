// SPDX-License-Identifier: GPL-3.0-or-later
// Shared interface for fixed-ratio prescale stages (dedither + ScaleFX / Super-xBR, FSRCNNX). The renderer runs a stage
// on the native frame, then resamples its output to the target rect (EASU when upscaling further, area downsample when
// the stage output is larger than the target).

/** Optional GPU timestamp hook: returns timestampWrites for a labelled pass, or undefined when not timing. */
export type PassTimer = (label: string) => GPURenderPassTimestampWrites | GPUComputePassTimestampWrites | undefined;

export interface StageOutput {
  view: GPUTextureView;
  width: number;
  height: number;
}

export interface UpscaleStage {
  /** Integer output/input ratio (ScaleFX 3, Super-xBR 2, FSRCNNX 2). */
  readonly ratio: number;
  /** Number of GPU passes encode() records (for timer capacity). */
  readonly passes: number;
  /**
   * Record the stage's passes reading `src` (an rgba8unorm texture of srcW x srcH, the native frame) and return its
   * output (rgba8unorm, srcW*ratio x srcH*ratio). Intermediate textures are owned by the stage, (re)created when the
   * source size changes, at most two working textures per resolution (ping-pong).
   */
  encode(enc: GPUCommandEncoder, src: GPUTextureView, srcW: number, srcH: number, timer?: PassTimer): StageOutput;
  /** Live GPU textures owned by the stage (leak tests). */
  liveTextures(): number;
  destroy(): void;
}
