#![cfg(target_arch = "wasm32")]

use effects::{ApplyEffectsOptions, EffectPass, UniformValue, UpscaleOptions};
use gpu::wgpu;
use js_sys::Object;
use serde::Deserialize;
use wasm_bindgen::{JsCast, JsValue, prelude::wasm_bindgen};

use crate::compositor::with_compositor_mut;
use crate::gpu::{
    import_canvas_texture, read_offscreen_canvas_property, read_property, read_serde_property,
    read_u32_property, render_texture_to_canvas, with_gpu_runtime, with_gpu_runtime_mut,
};

struct ApplyEffectPassesOptions {
    source: wgpu::web_sys::OffscreenCanvas,
    width: u32,
    height: u32,
    passes: Vec<EffectPassInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EffectPassInput {
    shader: String,
    uniforms: Vec<EffectUniformInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EffectUniformInput {
    name: String,
    value: Vec<f32>,
}

#[wasm_bindgen(js_name = applyEffectPasses)]
pub fn apply_effect_passes(options: JsValue) -> Result<wgpu::web_sys::OffscreenCanvas, JsValue> {
    let ApplyEffectPassesOptions {
        source,
        width,
        height,
        passes,
    } = parse_apply_effect_passes_options(options)?;

    with_gpu_runtime(|runtime| {
        let source_texture = import_canvas_texture(
            &runtime.context,
            &source,
            width,
            height,
            "effects-input-texture",
        );
        let effect_passes = map_effect_passes(passes);
        let result_texture = runtime
            .effects
            .apply(
                &runtime.context,
                ApplyEffectsOptions {
                    source: &source_texture,
                    width,
                    height,
                    passes: &effect_passes,
                },
            )
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        render_texture_to_canvas(&runtime.context, &result_texture, width, height)
    })
}

fn map_effect_passes(effect_passes: Vec<EffectPassInput>) -> Vec<EffectPass> {
    effect_passes
        .into_iter()
        .map(|pass| EffectPass {
            shader: pass.shader,
            uniforms: pass
                .uniforms
                .into_iter()
                .map(|uniform| {
                    let value = if uniform.value.len() == 1 {
                        UniformValue::Number(uniform.value[0])
                    } else {
                        UniformValue::Vector(uniform.value)
                    };
                    (uniform.name, value)
                })
                .collect(),
        })
        .collect()
}

fn parse_apply_effect_passes_options(value: JsValue) -> Result<ApplyEffectPassesOptions, JsValue> {
    let object: Object = value
        .dyn_into()
        .map_err(|_| JsValue::from_str("applyEffectPasses expects an options object"))?;

    Ok(ApplyEffectPassesOptions {
        source: read_offscreen_canvas_property(&object, "source")?,
        width: read_u32_property(&object, "width")?,
        height: read_u32_property(&object, "height")?,
        passes: read_serde_property(&object, "passes")?,
    })
}

/// Resample a canvas into a different size (up or down).
/// mode: 0 bilinear, 1 bicubic, 2 lanczos3.
#[wasm_bindgen(js_name = upscaleImage)]
pub fn upscale_image(options: JsValue) -> Result<wgpu::web_sys::OffscreenCanvas, JsValue> {
    let object: Object = options
        .dyn_into()
        .map_err(|_| JsValue::from_str("upscaleImage expects an options object"))?;
    let source = read_offscreen_canvas_property(&object, "source")?;
    let src_width = read_u32_property(&object, "srcWidth")?;
    let src_height = read_u32_property(&object, "srcHeight")?;
    let dst_width = read_u32_property(&object, "dstWidth")?;
    let dst_height = read_u32_property(&object, "dstHeight")?;
    let mode_value = read_property(&object, "mode")?;
    let mode = mode_value.as_f64().unwrap_or(1.0) as f32;

    with_gpu_runtime(|runtime| {
        let source_texture = import_canvas_texture(
            &runtime.context,
            &source,
            src_width,
            src_height,
            "upscale-input-texture",
        );
        let result_texture = runtime
            .effects
            .upscale(
                &runtime.context,
                UpscaleOptions {
                    source: &source_texture,
                    src_width,
                    src_height,
                    dst_width,
                    dst_height,
                    mode,
                },
            )
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        render_texture_to_canvas(&runtime.context, &result_texture, dst_width, dst_height)
    })
}

/// Shader ids supported by the deployed bundle. TS drops passes it does
/// not understand so an older bundle never breaks the frame.
#[wasm_bindgen(js_name = listEffectShaders)]
pub fn list_effect_shaders() -> Vec<js_sys::JsString> {
    effects::SHADER_IDS
        .iter()
        .map(|id| js_sys::JsString::from(*id))
        .collect()
}

/// Upload a Hald-strip LUT canvas (built by TS `lut/hald.ts`) into both the
/// preview pipeline and the compositor pipeline (when initialized).
#[wasm_bindgen(js_name = registerLutTexture)]
pub fn register_lut_texture(options: JsValue) -> Result<(), JsValue> {
    let object: Object = options
        .dyn_into()
        .map_err(|_| JsValue::from_str("registerLutTexture expects an options object"))?;
    let id = read_u32_property(&object, "id")?;
    let source = read_offscreen_canvas_property(&object, "source")?;
    let width = read_u32_property(&object, "width")?;
    let height = read_u32_property(&object, "height")?;
    let size = read_u32_property(&object, "size")?;

    with_gpu_runtime_mut(|runtime| {
        let texture =
            import_canvas_texture(&runtime.context, &source, width, height, "lut-texture");
        runtime.effects.register_lut(id, texture.clone(), size);
        with_compositor_mut(|compositor| {
            compositor.register_lut_texture(id, texture, size);
        });
        Ok(())
    })
}

#[wasm_bindgen(js_name = unregisterLutTexture)]
pub fn unregister_lut_texture(id: u32) -> Result<(), JsValue> {
    with_gpu_runtime_mut(|runtime| {
        runtime.effects.unregister_lut(id);
        with_compositor_mut(|compositor| {
            compositor.unregister_lut_texture(id);
        });
        Ok(())
    })
}
