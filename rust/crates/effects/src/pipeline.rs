use std::collections::HashMap;

use bytemuck::{Pod, Zeroable};
use gpu::{FULLSCREEN_SHADER_SOURCE, GpuContext};
use thiserror::Error;
use wgpu::util::DeviceExt;

use crate::{EffectPass, UniformValue};

pub const GAUSSIAN_BLUR_SHADER_ID: &str = "gaussian-blur";
pub const COLOR_GRADE_SHADER_ID: &str = "color-grade";
pub const HSL_SHIFT_SHADER_ID: &str = "hsl-shift";
pub const CURVES_SHADER_ID: &str = "curves";
pub const COLOR_FILTER_SHADER_ID: &str = "color-filter";
pub const LUT_3D_SHADER_ID: &str = "lut-3d";
pub const COLOR_GRADE_HSL_SHADER_ID: &str = "color-grade-hsl";
pub const COLOR_WHEELS_SHADER_ID: &str = "color-wheels";
pub const SHARPEN_SHADER_ID: &str = "sharpen";

const GAUSSIAN_BLUR_SHADER_SOURCE: &str = include_str!("shaders/gaussian_blur.wgsl");
const COLOR_GRADE_SHADER_SOURCE: &str = include_str!("shaders/color_grade.wgsl");
const HSL_SHIFT_SHADER_SOURCE: &str = include_str!("shaders/hsl_shift.wgsl");
const CURVES_SHADER_SOURCE: &str = include_str!("shaders/curves.wgsl");
const COLOR_FILTER_SHADER_SOURCE: &str = include_str!("shaders/color_filter.wgsl");
const LUT_3D_SHADER_SOURCE: &str = include_str!("shaders/lut_3d.wgsl");
const COLOR_GRADE_HSL_SHADER_SOURCE: &str = include_str!("shaders/color_grade_hsl.wgsl");
const COLOR_WHEELS_SHADER_SOURCE: &str = include_str!("shaders/color_wheels.wgsl");
const SHARPEN_SHADER_SOURCE: &str = include_str!("shaders/sharpen.wgsl");

/// All shader ids supported by this pipeline version.
/// Exposed to TS via `listEffectShaders` so the UI can drop passes the
/// deployed wasm bundle does not understand yet.
pub const SHADER_IDS: &[&str] = &[
    GAUSSIAN_BLUR_SHADER_ID,
    COLOR_GRADE_SHADER_ID,
    HSL_SHIFT_SHADER_ID,
    CURVES_SHADER_ID,
    COLOR_FILTER_SHADER_ID,
    LUT_3D_SHADER_ID,
    COLOR_GRADE_HSL_SHADER_ID,
    COLOR_WHEELS_SHADER_ID,
    SHARPEN_SHADER_ID,
];

/// Number of generic data floats shared by all color shaders.
/// Header (resolution + direction) stays for blur backward-compat.
pub const EFFECT_DATA_FLOATS: usize = 64;

pub struct ApplyEffectsOptions<'a> {
    pub source: &'a wgpu::Texture,
    pub width: u32,
    pub height: u32,
    pub passes: &'a [EffectPass],
}

pub struct EffectPipeline {
    uniform_bind_group_layout: wgpu::BindGroupLayout,
    pipelines: HashMap<String, wgpu::RenderPipeline>,
    lut_pipelines: HashMap<String, wgpu::RenderPipeline>,
    lut_textures: HashMap<u32, LutTexture>,
}

struct LutTexture {
    texture: wgpu::Texture,
    /// LUT edge size N (strip is N*N x N). Kept for validation/debugging;
    /// the shader reads N from uniforms.
    #[allow(dead_code)]
    size: u32,
}

#[derive(Debug, Error)]
pub enum EffectsError {
    #[error("At least one effect pass is required")]
    MissingEffectPasses,
    #[error("Unknown effect shader '{shader}'")]
    UnknownEffectShader { shader: String },
    #[error("Missing uniform '{uniform}' for shader '{shader}'")]
    MissingUniform { shader: String, uniform: String },
    #[error("Uniform '{uniform}' for shader '{shader}' must be a number")]
    InvalidNumberUniform { shader: String, uniform: String },
    #[error(
        "Uniform '{uniform}' for shader '{shader}' must be a vector of length {expected_length}"
    )]
    InvalidVectorUniform {
        shader: String,
        uniform: String,
        expected_length: usize,
    },
    #[error("Shader '{shader}' does not support uniform '{uniform}'")]
    UnsupportedUniform { shader: String, uniform: String },
    #[error("Uniform '{uniform}' for shader '{shader}' exceeds {max} floats")]
    UniformTooLarge {
        shader: String,
        uniform: String,
        max: usize,
    },
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct EffectUniformBuffer {
    resolution: [f32; 2],
    direction: [f32; 2],
    data: [f32; EFFECT_DATA_FLOATS],
}

impl EffectPipeline {
    pub fn new(context: &GpuContext) -> Self {
        let uniform_bind_group_layout =
            context
                .device()
                .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: Some("effects-uniform-bind-group-layout"),
                    entries: &[wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    }],
                });
        let vertex_shader_module =
            context
                .device()
                .create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("effects-fullscreen-shader"),
                    source: wgpu::ShaderSource::Wgsl(FULLSCREEN_SHADER_SOURCE.into()),
                });
        let pipeline_layout =
            context
                .device()
                .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("effects-pipeline-layout"),
                    bind_group_layouts: &[
                        Some(context.texture_sampler_bind_group_layout()),
                        Some(&uniform_bind_group_layout),
                    ],
                    immediate_size: 0,
                });

        let shaders: &[(&str, &str)] = &[
            (GAUSSIAN_BLUR_SHADER_ID, GAUSSIAN_BLUR_SHADER_SOURCE),
            (COLOR_GRADE_SHADER_ID, COLOR_GRADE_SHADER_SOURCE),
            (HSL_SHIFT_SHADER_ID, HSL_SHIFT_SHADER_SOURCE),
            (CURVES_SHADER_ID, CURVES_SHADER_SOURCE),
            (COLOR_FILTER_SHADER_ID, COLOR_FILTER_SHADER_SOURCE),
            (COLOR_GRADE_HSL_SHADER_ID, COLOR_GRADE_HSL_SHADER_SOURCE),
            (COLOR_WHEELS_SHADER_ID, COLOR_WHEELS_SHADER_SOURCE),
            (SHARPEN_SHADER_ID, SHARPEN_SHADER_SOURCE),
        ];

        let mut pipelines = HashMap::with_capacity(shaders.len() + 1);
        for (id, source) in shaders {
            pipelines.insert(
                id.to_string(),
                build_fullscreen_pipeline(
                    context,
                    &vertex_shader_module,
                    &pipeline_layout,
                    id,
                    source,
                ),
            );
        }

        // LUT passes need a third bind group (the LUT strip texture).
        let lut_pipeline_layout =
            context
                .device()
                .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("effects-lut-pipeline-layout"),
                    bind_group_layouts: &[
                        Some(context.texture_sampler_bind_group_layout()),
                        Some(&uniform_bind_group_layout),
                        Some(context.texture_sampler_bind_group_layout()),
                    ],
                    immediate_size: 0,
                });
        let lut_pipelines = HashMap::from([(
            LUT_3D_SHADER_ID.to_string(),
            build_fullscreen_pipeline(
                context,
                &vertex_shader_module,
                &lut_pipeline_layout,
                LUT_3D_SHADER_ID,
                LUT_3D_SHADER_SOURCE,
            ),
        )]);

        Self {
            uniform_bind_group_layout,
            pipelines,
            lut_pipelines,
            lut_textures: HashMap::new(),
        }
    }

    /// Register a Hald-strip LUT texture (built by TS `lut/hald.ts`).
    /// Re-registration with the same id replaces the previous texture.
    pub fn register_lut(&mut self, id: u32, texture: wgpu::Texture, size: u32) {
        self.lut_textures.insert(id, LutTexture { texture, size });
    }

    pub fn unregister_lut(&mut self, id: u32) {
        self.lut_textures.remove(&id);
    }

    pub fn apply(
        &self,
        context: &GpuContext,
        ApplyEffectsOptions {
            source,
            width,
            height,
            passes,
        }: ApplyEffectsOptions<'_>,
    ) -> Result<wgpu::Texture, EffectsError> {
        let mut encoder =
            context
                .device()
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("effects-command-encoder"),
                });
        let output = self.apply_with_encoder(
            context,
            &mut encoder,
            ApplyEffectsOptions {
                source,
                width,
                height,
                passes,
            },
        )?;
        context.queue().submit([encoder.finish()]);
        Ok(output)
    }

    pub fn apply_with_encoder(
        &self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        ApplyEffectsOptions {
            source,
            width,
            height,
            passes,
        }: ApplyEffectsOptions<'_>,
    ) -> Result<wgpu::Texture, EffectsError> {
        let mut current_texture: Option<wgpu::Texture> = None;

        for pass in passes {
            let input_texture = current_texture.as_ref().unwrap_or(source);
            let output_texture =
                context.create_render_texture(width, height, "effects-pass-output");
            let input_view = input_texture.create_view(&wgpu::TextureViewDescriptor::default());
            let output_view = output_texture.create_view(&wgpu::TextureViewDescriptor::default());
            let texture_bind_group =
                context
                    .device()
                    .create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("effects-texture-bind-group"),
                        layout: context.texture_sampler_bind_group_layout(),
                        entries: &[
                            wgpu::BindGroupEntry {
                                binding: 0,
                                resource: wgpu::BindingResource::TextureView(&input_view),
                            },
                            wgpu::BindGroupEntry {
                                binding: 1,
                                resource: wgpu::BindingResource::Sampler(context.linear_sampler()),
                            },
                        ],
                    });
            let uniform_buffer =
                context
                    .device()
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("effects-uniform-buffer"),
                        contents: bytemuck::bytes_of(&pack_effect_uniforms(pass, width, height)?),
                        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                    });
            let uniform_bind_group =
                context
                    .device()
                    .create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("effects-uniform-bind-group"),
                        layout: &self.uniform_bind_group_layout,
                        entries: &[wgpu::BindGroupEntry {
                            binding: 0,
                            resource: uniform_buffer.as_entire_binding(),
                        }],
                    });
            if pass.shader == LUT_3D_SHADER_ID {
                // LUT passes use a dedicated 3-bind-group pipeline; the
                // uniform buffer above is still required by the shader.
                self.apply_lut_pass(
                    context,
                    &mut *encoder,
                    input_texture,
                    &output_view,
                    pass,
                    &texture_bind_group,
                    &uniform_bind_group,
                )?;
                current_texture = Some(output_texture);
                continue;
            }
            let pipeline = self.pipelines.get(&pass.shader).ok_or_else(|| {
                EffectsError::UnknownEffectShader {
                    shader: pass.shader.clone(),
                }
            })?;

            {
                let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("effects-render-pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &output_view,
                        resolve_target: None,
                        depth_slice: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    occlusion_query_set: None,
                    timestamp_writes: None,
                    multiview_mask: None,
                });
                render_pass.set_pipeline(pipeline);
                render_pass.set_vertex_buffer(0, context.fullscreen_quad().slice(..));
                render_pass.set_bind_group(0, &texture_bind_group, &[]);
                render_pass.set_bind_group(1, &uniform_bind_group, &[]);
                render_pass.draw(0..6, 0..1);
            }

            current_texture = Some(output_texture);
        }

        current_texture.ok_or(EffectsError::MissingEffectPasses)
    }

    /// Render a `lut-3d` pass. A missing LUT texture is a silent no-op blit —
    /// a stale/evicted LUT id must never break the frame.
    #[allow(clippy::too_many_arguments)]
    fn apply_lut_pass(
        &self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        input_texture: &wgpu::Texture,
        output_view: &wgpu::TextureView,
        pass: &EffectPass,
        texture_bind_group: &wgpu::BindGroup,
        uniform_bind_group: &wgpu::BindGroup,
    ) -> Result<(), EffectsError> {
        let data = read_data_uniform(pass)?;
        let lut_id = data.get(2).copied().unwrap_or(0.0) as u32;
        let Some(lut) = self.lut_textures.get(&lut_id) else {
            context.encode_texture_blit_to_view(
                encoder,
                input_texture,
                output_view,
                "effects-lut-missing-blit",
            );
            return Ok(());
        };
        let pipeline =
            self.lut_pipelines
                .get(LUT_3D_SHADER_ID)
                .ok_or_else(|| EffectsError::UnknownEffectShader {
                    shader: LUT_3D_SHADER_ID.to_string(),
                })?;
        let lut_view = lut.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let lut_bind_group =
            context
                .device()
                .create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("effects-lut-texture-bind-group"),
                    layout: context.texture_sampler_bind_group_layout(),
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::TextureView(&lut_view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::Sampler(context.linear_sampler()),
                        },
                    ],
                });
        let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("effects-lut-render-pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: output_view,
                resolve_target: None,
                depth_slice: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            occlusion_query_set: None,
            timestamp_writes: None,
            multiview_mask: None,
        });
        render_pass.set_pipeline(pipeline);
        render_pass.set_vertex_buffer(0, context.fullscreen_quad().slice(..));
        render_pass.set_bind_group(0, texture_bind_group, &[]);
        render_pass.set_bind_group(1, uniform_bind_group, &[]);
        render_pass.set_bind_group(2, &lut_bind_group, &[]);
        render_pass.draw(0..6, 0..1);
        Ok(())
    }
}

fn build_fullscreen_pipeline(
    context: &GpuContext,
    vertex_shader_module: &wgpu::ShaderModule,
    pipeline_layout: &wgpu::PipelineLayout,
    id: &str,
    source: &str,
) -> wgpu::RenderPipeline {
    let module = context.device().create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(&format!("effects-{id}-shader")),
        source: wgpu::ShaderSource::Wgsl(source.into()),
    });
    context.device().create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(&format!("effects-{id}-pipeline")),
        layout: Some(pipeline_layout),
        vertex: wgpu::VertexState {
            module: vertex_shader_module,
            entry_point: Some("vertex_main"),
            buffers: &[wgpu::VertexBufferLayout {
                array_stride: std::mem::size_of::<[f32; 2]>() as u64,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &[wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32x2,
                    offset: 0,
                    shader_location: 0,
                }],
            }],
            compilation_options: wgpu::PipelineCompilationOptions::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: &module,
            entry_point: Some("fragment_main"),
            targets: &[Some(wgpu::ColorTargetState {
                format: context.texture_format(),
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
            compilation_options: wgpu::PipelineCompilationOptions::default(),
        }),
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview_mask: None,
        cache: None,
    })
}

fn pack_effect_uniforms(
    pass: &EffectPass,
    width: u32,
    height: u32,
) -> Result<EffectUniformBuffer, EffectsError> {
    match pass.shader.as_str() {
        GAUSSIAN_BLUR_SHADER_ID => pack_blur_uniforms(pass, width, height),
        COLOR_GRADE_SHADER_ID
        | HSL_SHIFT_SHADER_ID
        | CURVES_SHADER_ID
        | COLOR_FILTER_SHADER_ID
        | LUT_3D_SHADER_ID
        | COLOR_GRADE_HSL_SHADER_ID
        | COLOR_WHEELS_SHADER_ID
        | SHARPEN_SHADER_ID => pack_data_uniforms(pass, width, height),
        _ => Err(EffectsError::UnknownEffectShader {
            shader: pass.shader.clone(),
        }),
    }
}

fn base_buffer(
    width: u32,
    height: u32,
    direction: [f32; 2],
    data: [f32; EFFECT_DATA_FLOATS],
) -> EffectUniformBuffer {
    EffectUniformBuffer {
        resolution: [width as f32, height as f32],
        direction,
        data,
    }
}

fn pack_blur_uniforms(
    pass: &EffectPass,
    width: u32,
    height: u32,
) -> Result<EffectUniformBuffer, EffectsError> {
    let shader = pass.shader.as_str();
    let sigma = read_number_uniform(pass, "u_sigma")?;
    let step = read_number_uniform(pass, "u_step")?;
    let direction = read_vec2_uniform(pass, "u_direction")?;

    for uniform in pass.uniforms.keys() {
        if uniform == "u_sigma" || uniform == "u_step" || uniform == "u_direction" {
            continue;
        }
        return Err(EffectsError::UnsupportedUniform {
            shader: shader.to_string(),
            uniform: uniform.clone(),
        });
    }

    let mut data = [0.0f32; EFFECT_DATA_FLOATS];
    data[0] = sigma;
    data[1] = step;
    Ok(base_buffer(width, height, direction, data))
}

/// Generic path for color shaders: single `u_data` vector (or number).
fn pack_data_uniforms(
    pass: &EffectPass,
    width: u32,
    height: u32,
) -> Result<EffectUniformBuffer, EffectsError> {
    let shader = pass.shader.as_str();
    let values = read_data_uniform(pass)?;
    if values.len() > EFFECT_DATA_FLOATS {
        return Err(EffectsError::UniformTooLarge {
            shader: shader.to_string(),
            uniform: "u_data".to_string(),
            max: EFFECT_DATA_FLOATS,
        });
    }
    for uniform in pass.uniforms.keys() {
        if uniform == "u_data" {
            continue;
        }
        return Err(EffectsError::UnsupportedUniform {
            shader: shader.to_string(),
            uniform: uniform.clone(),
        });
    }
    let mut data = [0.0f32; EFFECT_DATA_FLOATS];
    data[..values.len()].copy_from_slice(&values);
    Ok(base_buffer(width, height, [0.0, 0.0], data))
}

fn read_data_uniform(pass: &EffectPass) -> Result<Vec<f32>, EffectsError> {
    let Some(value) = pass.uniforms.get("u_data") else {
        return Err(EffectsError::MissingUniform {
            shader: pass.shader.clone(),
            uniform: "u_data".to_string(),
        });
    };
    match value {
        UniformValue::Number(n) => Ok(vec![*n]),
        UniformValue::Vector(v) => Ok(v.clone()),
    }
}

fn read_number_uniform(pass: &EffectPass, uniform: &str) -> Result<f32, EffectsError> {
    let Some(value) = pass.uniforms.get(uniform) else {
        return Err(EffectsError::MissingUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
        });
    };
    match value {
        UniformValue::Number(value) => Ok(*value),
        UniformValue::Vector(_) => Err(EffectsError::InvalidNumberUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
        }),
    }
}

fn read_vec2_uniform(pass: &EffectPass, uniform: &str) -> Result<[f32; 2], EffectsError> {
    let Some(value) = pass.uniforms.get(uniform) else {
        return Err(EffectsError::MissingUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
        });
    };
    let UniformValue::Vector(values) = value else {
        return Err(EffectsError::InvalidVectorUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
            expected_length: 2,
        });
    };
    if values.len() != 2 {
        return Err(EffectsError::InvalidVectorUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
            expected_length: 2,
        });
    }
    Ok([values[0], values[1]])
}
