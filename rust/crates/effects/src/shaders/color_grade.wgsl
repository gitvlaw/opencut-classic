// Color grade shader — CapCut-style Adjust.
//
// Working space: this shader decodes sRGB -> linear light, does exposure,
// white balance, contrast and saturation in linear, then encodes back.
// Hue/fade stay display-referred (sRGB) as creative "look" ops.
// Blend/composite/masks elsewhere remain sRGB (browser-consistent); only
// radiometry-sensitive ops (grade, blur, sharpen) are linear-correct.
//
// data[] layout:
//   0 exposureEV [-3,+3]        1 brightness [-1,+1] (mapped from -100..100)
//   2 contrast [-1,+1]          3 saturation [-1,+1]
//   4 vibrance [-1,+1]          5 temperature [-1,+1]  6 tint [-1,+1]
//   7 highlights [-1,+1]        8 shadows [-1,+1]
//   9 whites [-1,+1]            10 blacks [-1,+1]
//   11 hueDeg [-180,+180]       12 fade [0,1]
//   13 sharpness — handled by the separate sharpen pass, ignored here
//   14..63 reserved (0)

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec2f,
    direction: vec2f,
    data: array<f32, 64>,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

const LUMA_BT709 = vec3f(0.2126, 0.7152, 0.0722);

fn srgb_to_linear(c: vec3f) -> vec3f {
    let lo = c / 12.92;
    let hi = pow((c + vec3f(0.055)) / vec3f(1.055), vec3f(2.4));
    return mix(hi, lo, vec3f(1.0) - step(vec3f(0.04045), c));
}

fn linear_to_srgb(c: vec3f) -> vec3f {
    let lo = c * 12.92;
    let hi = vec3f(1.055) * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - vec3f(0.055);
    return mix(hi, lo, vec3f(1.0) - step(vec3f(0.0031308), c));
}

fn luma(c: vec3f) -> f32 {
    return dot(c, LUMA_BT709);
}

// --- Bradford chromatic adaptation (white balance) ---
fn srgb_to_bradford_lms(c: vec3f) -> vec3f {
    let x = 0.4124564 * c.r + 0.3575761 * c.g + 0.1804375 * c.b;
    let y = 0.2126729 * c.r + 0.7151522 * c.g + 0.0721750 * c.b;
    let z = 0.0193339 * c.r + 0.1191920 * c.g + 0.9503041 * c.b;
    return vec3f(
        0.8951 * x + 0.2664 * y - 0.1614 * z,
        -0.7502 * x + 1.7135 * y + 0.0367 * z,
        0.0389 * x - 0.0685 * y + 1.0296 * z,
    );
}

fn bradford_lms_to_srgb(lms: vec3f) -> vec3f {
    let x = 0.9869929 * lms.r - 0.1470543 * lms.g + 0.1599627 * lms.b;
    let y = 0.4323053 * lms.r + 0.5183603 * lms.g + 0.0492912 * lms.b;
    let z = -0.0085287 * lms.r + 0.0400428 * lms.g + 0.9684867 * lms.b;
    return vec3f(
        3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
        -0.9692660 * x + 1.8760108 * y + 0.0415560 * z,
        0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
    );
}

fn white_balance(x: vec3f, temp: f32, tint: f32) -> vec3f {
    if (abs(temp) < 0.001 && abs(tint) < 0.001) {
        return x;
    }
    // Von Kries gains in Bradford cone space: temperature drives the
    // red/blue axis, tint drives green/magenta.
    let gains = vec3f(1.0 + temp * 0.22, 1.0 + tint * 0.10, 1.0 - temp * 0.22 - tint * 0.03);
    return bradford_lms_to_srgb(srgb_to_bradford_lms(max(x, vec3f(0.0))) * gains);
}

// --- OKLCH saturation (hue-preserving, needs linear input) ---
fn linear_to_oklab(c: vec3f) -> vec3f {
    let l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
    let m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
    let s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
    let l_ = pow(max(l, 0.0), 1.0 / 3.0);
    let m_ = pow(max(m, 0.0), 1.0 / 3.0);
    let s_ = pow(max(s, 0.0), 1.0 / 3.0);
    return vec3f(
        0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
        1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
        0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    );
}

fn oklab_to_linear(lab: vec3f) -> vec3f {
    let l_ = lab.r + 0.3963377774 * lab.g + 0.2158037573 * lab.b;
    let m_ = lab.r - 0.1055613458 * lab.g - 0.0638541728 * lab.b;
    let s_ = lab.r - 0.0894841775 * lab.g - 1.2914855480 * lab.b;
    let l = l_ * l_ * l_;
    let m = m_ * m_ * m_;
    let s = s_ * s_ * s_;
    return vec3f(
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    );
}

fn tonal_region(mask_luma: f32, center: f32, width: f32) -> f32 {
    let dd = (mask_luma - center) / width;
    return exp(-dd * dd);
}

fn hue_rotate(x: vec3f, deg: f32) -> vec3f {
    if (abs(deg) < 0.01) {
        return x;
    }
    let rad = radians(deg);
    let c = cos(rad);
    let s = sin(rad);
    // YIQ rotation matrix (hue only, luma-preserving approx, sRGB domain).
    let r = 0.299 + 0.701 * c + 0.168 * s;
    let g = 0.587 - 0.587 * c + 0.330 * s;
    let b = 0.114 - 0.114 * c - 0.497 * s;
    let r2 = 0.299 - 0.299 * c - 0.328 * s;
    let g2 = 0.587 + 0.413 * c + 0.035 * s;
    let b2 = 0.114 - 0.114 * c + 0.292 * s;
    let r3 = 0.299 - 0.300 * c + 1.250 * s;
    let g3 = 0.587 - 0.588 * c - 1.050 * s;
    let b3 = 0.114 + 0.886 * c - 0.200 * s;
    return vec3f(
        x.r * r + x.g * g + x.b * b,
        x.r * r2 + x.g * g2 + x.b * b2,
        x.r * r3 + x.g * g3 + x.b * b3,
    );
}

fn soft_clip_channel(c: f32) -> f32 {
    // Smooth shoulder above ~0.85 (linear): compress instead of hard clip.
    if (c <= 0.85) {
        return c;
    }
    let t = c - 0.85;
    return 0.85 + t / (1.0 + t * 2.0);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let src = textureSample(input_texture, input_sampler, input.tex_coord);
    let d = uniforms.data;

    // ---- linear light domain ----
    var rgb = srgb_to_linear(clamp(src.rgb, vec3f(0.0), vec3f(1.0)));
    rgb = rgb * exp2(d[0]);
    rgb = white_balance(rgb, d[5], d[6]);

    // Contrast around middle gray (0.18 linear), brightness as small lift.
    rgb = (rgb - vec3f(0.18)) * (1.0 + d[2]) + vec3f(0.18) + vec3f(d[1] * 0.25);

    // Tonal weights on perceptual (gamma) luma — centers match the old sRGB UI.
    let lp = pow(clamp(luma(rgb), 0.0, 1.0), 1.0 / 2.2);
    rgb = rgb
        + d[8] * tonal_region(lp, 0.2, 0.28) * 0.35
        + d[7] * tonal_region(lp, 0.8, 0.28) * 0.35
        + d[10] * tonal_region(lp, 0.05, 0.12) * 0.45
        + d[9] * tonal_region(lp, 0.95, 0.12) * 0.45;

    // Saturation + vibrance in OKLCH (hue-preserving) with skin protection.
    let lab = linear_to_oklab(max(rgb, vec3f(0.0)));
    let chroma = length(lab.yz);
    let hue_ang = atan2(lab.b, lab.g);
    var hue_deg = degrees(hue_ang);
    if (hue_deg < 0.0) {
        hue_deg = hue_deg + 360.0;
    }
    // Skin-tone line ~ OKLCH 50-70deg, moderate chroma, mid lightness.
    let skin_h = exp(-pow((hue_deg - 55.0) / 28.0, 2.0));
    let skin_c = smoothstep(0.015, 0.05, chroma);
    let skin_l = smoothstep(0.25, 0.42, lab.r) * (1.0 - smoothstep(0.78, 0.92, lab.r));
    let skin_w = skin_h * skin_c * skin_l;
    let sat_scale = 1.0 + d[3] * mix(1.0, 0.3, skin_w * step(0.0, d[3]));
    let vib_mask = clamp(1.0 - chroma * 4.0, 0.0, 1.0);
    let vib_scale = 1.0 + d[4] * (0.35 + 0.65 * vib_mask) * mix(1.0, 0.5, skin_w * step(0.0, d[4]));
    let new_c = chroma * sat_scale * vib_scale;
    let new_a = cos(hue_ang) * new_c;
    let new_b = sin(hue_ang) * new_c;
    rgb = oklab_to_linear(vec3f(lab.r, new_a, new_b));

    // Highlight rolloff: desaturate toward luma near clip, then soft shoulder.
    let mx = max(rgb.r, max(rgb.g, rgb.b));
    let clip_k = smoothstep(0.7, 1.3, mx);
    rgb = mix(rgb, vec3f(luma(rgb)), clip_k * 0.5);
    rgb = vec3f(soft_clip_channel(rgb.r), soft_clip_channel(rgb.g), soft_clip_channel(rgb.b));

    // ---- back to display-referred sRGB ----
    rgb = linear_to_srgb(rgb);
    rgb = hue_rotate(rgb, d[11]);
    rgb = mix(rgb, vec3f(luma(rgb)) * 0.5 + vec3f(0.25), clamp(d[12], 0.0, 1.0) * 0.55);
    rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));

    return vec4f(rgb, src.a);
}
