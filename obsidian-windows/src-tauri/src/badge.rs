//! Значок с числом непрочитанных поверх иконки на панели задач.
//!
//! На Windows `set_badge_count` не поддержан — там принят overlay icon, то есть
//! маленькая картинка, которую система рисует в углу иконки приложения. Картинку
//! приходится готовить самим.
//!
//! Шрифт здесь свой, 3×5 точек, и это не изобретательство от скуки: тянуть
//! растеризатор шрифтов ради двух цифр в круге диаметром шестнадцать точек —
//! обмен, в котором проигрывают обе стороны. На таком размере от гарнитуры всё
//! равно ничего не остаётся.

/// Сторона значка в точках. Больше система всё равно ужмёт.
const SIZE: u32 = 32;

/// Цифры 0–9 и знак «+», по три точки в ширину и пять в высоту.
/// Каждая строка — три бита, старший слева.
const GLYPHS: [[u8; 5]; 11] = [
    [0b111, 0b101, 0b101, 0b101, 0b111], // 0
    [0b010, 0b110, 0b010, 0b010, 0b111], // 1
    [0b111, 0b001, 0b111, 0b100, 0b111], // 2
    [0b111, 0b001, 0b111, 0b001, 0b111], // 3
    [0b101, 0b101, 0b111, 0b001, 0b001], // 4
    [0b111, 0b100, 0b111, 0b001, 0b111], // 5
    [0b111, 0b100, 0b111, 0b101, 0b111], // 6
    [0b111, 0b001, 0b010, 0b010, 0b010], // 7
    [0b111, 0b101, 0b111, 0b101, 0b111], // 8
    [0b111, 0b101, 0b111, 0b001, 0b111], // 9
    [0b000, 0b010, 0b111, 0b010, 0b000], // +
];

/// Готовит RGBA-картинку значка: круг с числом.
///
/// Больше девяти показываем как «9+»: две цифры на таком размере ещё читаются,
/// три — уже нет, а точное число непрочитанных на панели задач никому не нужно.
pub fn render(count: u32) -> Vec<u8> {
    let mut pixels = vec![0u8; (SIZE * SIZE * 4) as usize];

    let radius = SIZE as f32 / 2.0;
    let center = radius - 0.5;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 - center;
            let dy = y as f32 - center;
            let distance = (dx * dx + dy * dy).sqrt();
            // Мягкий край: без него круг на панели задач выглядит рваным.
            let alpha = ((radius - distance) * 2.0).clamp(0.0, 1.0);
            if alpha <= 0.0 {
                continue;
            }
            put(&mut pixels, x, y, [232, 74, 79, (alpha * 255.0) as u8]);
        }
    }

    let digits: Vec<usize> = if count > 9 { vec![9, 10] } else { vec![count as usize] };
    // Масштаб подобран так, чтобы две цифры с промежутком влезли по ширине.
    let scale = 4;
    let glyph_w = 3 * scale;
    let gap = scale;
    let total = digits.len() as u32 * glyph_w + (digits.len() as u32 - 1) * gap;
    let mut pen_x = (SIZE - total) / 2;
    let pen_y = (SIZE - 5 * scale) / 2;

    for digit in digits {
        draw_glyph(&mut pixels, &GLYPHS[digit], pen_x, pen_y, scale);
        pen_x += glyph_w + gap;
    }
    pixels
}

pub const fn size() -> u32 {
    SIZE
}

fn draw_glyph(pixels: &mut [u8], glyph: &[u8; 5], at_x: u32, at_y: u32, scale: u32) {
    for (row, bits) in glyph.iter().enumerate() {
        for column in 0..3u32 {
            if bits & (0b100 >> column) == 0 {
                continue;
            }
            for dy in 0..scale {
                for dx in 0..scale {
                    let x = at_x + column * scale + dx;
                    let y = at_y + row as u32 * scale + dy;
                    if x < SIZE && y < SIZE {
                        put(pixels, x, y, [255, 255, 255, 255]);
                    }
                }
            }
        }
    }
}

fn put(pixels: &mut [u8], x: u32, y: u32, rgba: [u8; 4]) {
    let at = ((y * SIZE + x) * 4) as usize;
    pixels[at..at + 4].copy_from_slice(&rgba);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alpha_at(pixels: &[u8], x: u32, y: u32) -> u8 {
        pixels[((y * SIZE + x) * 4 + 3) as usize]
    }

    #[test]
    fn the_badge_is_a_filled_circle() {
        let pixels = render(1);
        assert_eq!(pixels.len(), (SIZE * SIZE * 4) as usize);
        // Углы прозрачны, середина — нет.
        assert_eq!(alpha_at(&pixels, 0, 0), 0, "угол должен быть прозрачным");
        assert_eq!(alpha_at(&pixels, SIZE - 1, SIZE - 1), 0);
        assert_eq!(alpha_at(&pixels, SIZE / 2, SIZE / 2), 255, "середина должна быть закрашена");
    }

    #[test]
    fn digits_are_drawn_in_white() {
        let white = |pixels: &Vec<u8>| {
            pixels
                .chunks(4)
                .filter(|p| p[0] == 255 && p[1] == 255 && p[2] == 255 && p[3] == 255)
                .count()
        };
        // У единицы белых точек меньше, чем у восьмёрки: рисунок разный.
        assert!(white(&render(1)) > 0, "цифра не нарисована");
        assert!(white(&render(8)) > white(&render(1)));
    }

    #[test]
    fn more_than_nine_becomes_nine_plus() {
        // «10» и «99» рисуются одинаково: это одно и то же «9+».
        assert_eq!(render(10), render(99));
        assert_ne!(render(9), render(10));
    }
}
