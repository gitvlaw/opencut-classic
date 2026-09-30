// Fused Adjust + HSL shader — one pass instead of two.
// data[] layout: [0..13] color-grade params (see color_grade.wgsl),
// [14..15] padding, [16..39] HSL 8 bands x (hue, sat, lum) (see hsl_shift.wgsl).
// Emitted by TS fuseColorPassGroups() when an Adjust effect is immediately
// followed by an HSL effect. Grade section works in linear light like
// color_grade.wgsl; HSL stays display-referred.

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

fn luma(c: vec3f) -> f32 {
    return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn white_balance(x: vec3f, temp: f32, tint: f32) -> vec3f {
    if (abs(temp) < 0.001 && abs(tint) < 0.001) {
        return x;
    }
    let gains = vec3f(1.0 + temp * 0.22, 1.0 + tint * 0.10, 1.0 - temp * 0.22 - tint * 0.03);
    return bradford_lms_to_srgb(srgb_to_bradford_lms(max(x, vec3f(0.0))) * gains);
}

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

fn soft_clip_channel(c: f32) -> f32 {
    if (c <= 0.85) {
        return c;
    }
    let t = c - 0.85;
    return 0.85 + t / (1.0 + t * 2.0);
}

fn tonal_region(mask_luma: f32, center: f32, width: f32) -> f32 {
    let d = (mask_luma - center) / width;
    return exp(-d * d);
}

fn rgb_to_hsl(c: vec3f) -> vec3f {
    let mx = max(max(c.r, c.g), c.b);
    let mn = min(min(c.r, c.g), c.b);
    let l = (mx + mn) * 0.5;
    var h = 0.0;
    var s = 0.0;
    let d = mx - mn;
    if (d > 0.0001) {
        if (l < 0.5) {
            s = d / (mx + mn);
        } else {
            s = d / (2.0 - mx - mn);
        }
        if (mx == c.r) {
            h = (c.g - c.b) / d;
            if (c.g < c.b) {
                h = h + 6.0;
            }
        } else if (mx == c.g) {
            h = (c.b - c.r) / d + 2.0;
        } else {
            h = (c.r - c.g) / d + 4.0;
        }
        h = h * 60.0;
    }
    return vec3f(h, s, l);
}

fn hue_to_rgb(p: f32, q: f32, t: f32) -> f32 {
    var tt = t;
    if (tt < 0.0) {
        tt = tt + 1.0;
    }
    if (tt > 1.0) {
        tt = tt - 1.0;
    }
    if (tt < 0.1666667) {
        return p + (q - p) * 6.0 * tt;
    }
    if (tt < 0.5) {
        return q;
    }
    if (tt < 0.6666667) {
        return p + (q - p) * (0.6666667 - tt) * 6.0;
    }
    return p;
}

fn hsl_to_rgb(hsl: vec3f) -> vec3f {
    let h = hsl.x / 360.0;
    let s = clamp(hsl.y, 0.0, 1.0);
    let l = clamp(hsl.z, 0.0, 1.0);
    if (s < 0.0001) {
        return vec3f(l);
    }
    var q = l;
    if (l < 0.5) {
        q = l * (1.0 + s);
    } else {
        q = l + s - l * s;
    }
    let p = 2.0 * l - q;
    return vec3f(
        hue_to_rgb(p, q, h + 0.3333333),
        hue_to_rgb(p, q, h),
        hue_to_rgb(p, q, h - 0.3333333),
    );
}

fn hue_rotate(x: vec3f, deg: f32) -> vec3f {
    if (abs(deg) < 0.01) {
        return x;
    }
    let rad = radians(deg);
    let c = cos(rad);
    let s = sin(rad);
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

fn band_weight(hue: f32, center: f32) -> f32 {
    var d = abs(hue - center);
    d = min(d, 360.0 - d);
    return clamp(1.0 - d / 30.0, 0.0, 1.0);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let src = textureSample(input_texture, input_sampler, input.tex_coord);
    let d = uniforms.data;

    // --- grade (linear light) ---
    var rgb = srgb_to_linear(clamp(src.rgb, vec3f(0.0), vec3f(1.0)));
    rgb = rgb * exp2(d[0]);
    rgb = white_balance(rgb, d[5], d[6]);
    rgb = (rgb - vec3f(0.18)) * (1.0 + d[2]) + vec3f(0.18) + vec3f(d[1] * 0.25);
    let lp = pow(clamp(luma(rgb), 0.0, 1.0), 1.0 / 2.2);
    rgb = rgb
        + d[8] * tonal_region(lp, 0.2, 0.28) * 0.35
        + d[7] * tonal_region(lp, 0.8, 0.28) * 0.35
        + d[10] * tonal_region(lp, 0.05, 0.12) * 0.45
        + d[9] * tonal_region(lp, 0.95, 0.12) * 0.45;
    let lab = linear_to_oklab(max(rgb, vec3f(0.0)));
    let chroma = length(lab.yz);
    let hue_ang = atan2(lab.b, lab.g);
    var hue_deg = degrees(hue_ang);
    if (hue_deg < 0.0) {
        hue_deg = hue_deg + 360.0;
    }
    let skin_h = exp(-pow((hue_deg - 55.0) / 28.0, 2.0));
    let skin_c = smoothstep(0.015, 0.05, chroma);
    let skin_l = smoothstep(0.25, 0.42, lab.r) * (1.0 - smoothstep(0.78, 0.92, lab.r));
    let skin_w = skin_h * skin_c * skin_l;
    let sat_scale = 1.0 + d[3] * mix(1.0, 0.3, skin_w * step(0.0, d[3]));
    let vib_mask = clamp(1.0 - chroma * 4.0, 0.0, 1.0);
    let vib_scale = 1.0 + d[4] * (0.35 + 0.65 * vib_mask) * mix(1.0, 0.5, skin_w * step(0.0, d[4]));
    let new_c = chroma * sat_scale * vib_scale;
    rgb = oklab_to_linear(vec3f(lab.r, cos(hue_ang) * new_c, sin(hue_ang) * new_c));
    let mx = max(rgb.r, max(rgb.g, rgb.b));
    let clip_k = smoothstep(0.7, 1.3, mx);
    rgb = mix(rgb, vec3f(luma(rgb)), clip_k * 0.5);
    rgb = vec3f(soft_clip_channel(rgb.r), soft_clip_channel(rgb.g), soft_clip_channel(rgb.b));
    rgb = linear_to_srgb(rgb);
    rgb = hue_rotate(rgb, d[11]);
    rgb = mix(rgb, vec3f(luma(rgb)) * 0.5 + vec3f(0.25), clamp(d[12], 0.0, 1.0) * 0.55);
    rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));

    // --- hsl (data base 16) ---
    var hsl = rgb_to_hsl(rgb);
    var total_h = 0.0;
    var total_s = 0.0;
    var total_l = 0.0;
    var total_w = 0.0;
    for (var i = 0; i < 8; i = i + 1) {
        var center = 0.0;
        switch (i) {
            case 0: { center = 0.0; }
            case 1: { center = 30.0; }
            case 2: { center = 60.0; }
            case 3: { center = 120.0; }
            case 4: { center = 180.0; }
            case 5: { center = 240.0; }
            case 6: { center = 270.0; }
            default: { center = 315.0; }
        }
        let w = band_weight(hsl.x, center);
        total_h = total_h + uniforms.data[16 + i * 3 + 0] * 180.0 * w;
        total_s = total_s + uniforms.data[16 + i * 3 + 1] * w;
        total_l = total_l + uniforms.data[16 + i * 3 + 2] * 0.5 * w;
        total_w = total_w + w;
    }
    if (total_w > 0.001) {
        hsl.x = hsl.x + total_h;
        if (hsl.x < 0.0) {
            hsl.x = hsl.x + 360.0;
        }
        if (hsl.x >= 360.0) {
            hsl.x = hsl.x - 360.0;
        }
        hsl.y = clamp(hsl.y * (1.0 + total_s) + total_s * 0.1, 0.0, 1.0);
        hsl.z = clamp(hsl.z + total_l, 0.0, 1.0);
    }

    return vec4f(clamp(hsl_to_rgb(hsl), vec3f(0.0), vec3f(1.0)), src.a);
}
