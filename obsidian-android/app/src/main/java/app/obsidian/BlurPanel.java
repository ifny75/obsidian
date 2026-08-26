package app.obsidian;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Rect;
import android.graphics.RectF;
import android.util.AttributeSet;
import android.view.View;
import android.widget.FrameLayout;

/**
 * Панель, размывающая то, что лежит под ней.
 *
 * Android не даёт «размытия подложки» готовым свойством: RenderEffect размывает
 * только сам элемент, а setBackgroundBlurRadius — окно целиком. Поэтому кусок
 * экрана под островком снимается в маленькую картинку и рисуется обратно
 * растянутым: уменьшение с последующим увеличением и есть размытие, причём
 * дешёвое — снимок в восемь раз меньше островка.
 *
 * Через аппаратный слой это сделать не вышло: перерисовка чужого элемента
 * внутри своего кадра упирается в «Recording currently in progress» — display
 * list этого элемента уже пишется. Софтверный холст такой петли не создаёт.
 */
public class BlurPanel extends FrameLayout {
    private static final float RADIUS_DP = 26f;
    /** Во сколько раз уменьшать снимок. Больше — мягче и дешевле, но грубее. */
    private static final int SCALE = 8;

    private final Paint paint = new Paint(Paint.FILTER_BITMAP_FLAG | Paint.ANTI_ALIAS_FLAG);
    private final Path clip = new Path();
    private final Rect source_rect = new Rect();
    private final RectF target = new RectF();

    private Bitmap shot;
    private Canvas shotCanvas;

    /** Что размывать: экран под островком. */
    private View source;

    public BlurPanel(Context context) { this(context, null); }

    public BlurPanel(Context context, AttributeSet attrs) {
        super(context, attrs);
        setWillNotDraw(false);
    }

    public void setSource(View source) {
        this.source = source;
        invalidate();
    }

    @Override
    protected void dispatchDraw(Canvas canvas) {
        drawBackdrop(canvas);
        super.dispatchDraw(canvas);
    }

    private void drawBackdrop(Canvas canvas) {
        View behind = source;
        if (behind == null || behind.getVisibility() != View.VISIBLE) return;

        int width = getWidth();
        int height = getHeight();
        if (width == 0 || height == 0) return;

        int small = Math.max(1, width / SCALE);
        int tall = Math.max(1, height / SCALE);
        if (shot == null || shot.getWidth() != small || shot.getHeight() != tall) {
            shot = Bitmap.createBitmap(small, tall, Bitmap.Config.ARGB_8888);
            shotCanvas = new Canvas(shot);
        }

        shot.eraseColor(Color.TRANSPARENT);
        shotCanvas.save();
        shotCanvas.scale(1f / SCALE, 1f / SCALE);
        // Сдвигаем так, чтобы в снимок попал ровно тот кусок, что под нами.
        shotCanvas.translate(-getLeft(), -getTop());
        try {
            behind.draw(shotCanvas);
        } catch (RuntimeException error) {
            // Не отрисовалось — останется просто стекло. Ронять приложение
            // из-за оформления нельзя.
            shotCanvas.restore();
            return;
        }
        shotCanvas.restore();

        float radius = RADIUS_DP * getResources().getDisplayMetrics().density;
        clip.reset();
        clip.addRoundRect(0, 0, width, height, radius, radius, Path.Direction.CW);
        source_rect.set(0, 0, small, tall);
        target.set(0, 0, width, height);

        canvas.save();
        canvas.clipPath(clip);
        canvas.drawBitmap(shot, source_rect, target, paint);
        canvas.restore();
    }
}
