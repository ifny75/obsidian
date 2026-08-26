package app.obsidian;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Path;
import android.graphics.RecordingCanvas;
import android.graphics.RenderEffect;
import android.graphics.RenderNode;
import android.graphics.Shader;
import android.os.Build;
import android.util.AttributeSet;
import android.view.View;
import android.widget.FrameLayout;

/**
 * Панель, размывающая то, что лежит под ней.
 *
 * Android не даёт «размытия подложки» готовым свойством: размывать умеет только
 * сам себя (RenderEffect) либо окно целиком (setBackgroundBlurRadius), а нам
 * нужно ни то, ни другое. Поэтому содержимое под островком перерисовывается в
 * отдельный слой, слой размывается и рисуется фоном.
 *
 * Где это не работает — до Android 12 и на программном холсте — панель остаётся
 * просто полупрозрачной. Лучше честная полупрозрачность, чем чёрный прямоугольник.
 */
public class BlurPanel extends FrameLayout {
    private static final float RADIUS_DP = 26f;
    private static final float BLUR = 26f;

    private final RenderNode node = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            ? new RenderNode("island-blur") : null;
    private final Path clip = new Path();

    /** Что размывать. Обязательно сосед по дереву, а не предок: иначе рисование зациклится. */
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
        if (node == null || source == null || source.getVisibility() != View.VISIBLE) return;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || !canvas.isHardwareAccelerated()) return;

        int width = getWidth();
        int height = getHeight();
        if (width == 0 || height == 0) return;

        node.setPosition(0, 0, width, height);
        node.setRenderEffect(RenderEffect.createBlurEffect(BLUR, BLUR, Shader.TileMode.CLAMP));

        RecordingCanvas recording = node.beginRecording();
        // Сдвигаем так, чтобы под островком оказался именно тот кусок экрана,
        // который под ним и лежит.
        recording.translate(-getLeft(), -getTop());
        source.draw(recording);
        node.endRecording();

        float radius = RADIUS_DP * getResources().getDisplayMetrics().density;
        clip.reset();
        clip.addRoundRect(0, 0, width, height, radius, radius, Path.Direction.CW);

        canvas.save();
        canvas.clipPath(clip);
        canvas.drawRenderNode(node);
        canvas.restore();
    }
}
