package app.valanium;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.util.AttributeSet;
import android.view.MotionEvent;
import android.view.View;
import android.view.animation.LinearInterpolator;

/** Интерактивная схема маршрута с движущимися слева направо импульсами. */
public final class RoutingView extends View {
    public interface OnModeChangedListener { void onModeChanged(String mode); }

    private static final String[] MODES = {"auto", "basic", "multihop", "onion"};
    private static final int[] TITLES = {
            R.string.transport_auto_title, R.string.transport_basic_title,
            R.string.transport_multihop_title, R.string.transport_onion_title
    };
    private static final int[] SUBTITLES = {
            R.string.transport_auto_hint, R.string.transport_basic_hint,
            R.string.transport_multihop_hint, R.string.transport_onion_card_hint
    };

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF card = new RectF();
    private final Drawable laptop;
    private final Drawable relay;
    private final Drawable envelope;
    private final Drawable tor;
    private ValueAnimator animator;
    private float phase;
    private int selected;
    private OnModeChangedListener listener;

    public RoutingView(Context context, AttributeSet attrs) {
        super(context, attrs);
        laptop = context.getDrawable(R.drawable.routing_laptop);
        relay = context.getDrawable(R.drawable.routing_database);
        envelope = context.getDrawable(R.drawable.routing_envelope);
        tor = context.getDrawable(R.drawable.routing_tor);
        for (Drawable icon : new Drawable[]{laptop, relay, envelope, tor}) {
            if (icon != null) icon.setTint(Color.rgb(245, 245, 243));
        }
        setFocusable(true);
        setClickable(true);
        setContentDescription(context.getString(R.string.transport_title));
    }

    public void setMode(String mode) {
        for (int i = 0; i < MODES.length; i++) {
            if (MODES[i].equals(mode)) selected = i;
        }
        invalidate();
    }

    public void setOnModeChangedListener(OnModeChangedListener value) { listener = value; }

    @Override protected void onMeasure(int widthSpec, int heightSpec) {
        int wanted = dp(4 * 112 + 3 * 8);
        setMeasuredDimension(MeasureSpec.getSize(widthSpec), resolveSize(wanted, heightSpec));
    }

    @Override protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        animator = ValueAnimator.ofFloat(0f, 1f);
        animator.setDuration(1650L);
        animator.setRepeatCount(ValueAnimator.INFINITE);
        animator.setInterpolator(new LinearInterpolator());
        animator.addUpdateListener(value -> {
            phase = (float) value.getAnimatedValue();
            invalidate();
        });
        animator.start();
    }

    @Override protected void onDetachedFromWindow() {
        if (animator != null) animator.cancel();
        super.onDetachedFromWindow();
    }

    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float gap = dp(8);
        float h = (getHeight() - gap * 3) / 4f;
        for (int i = 0; i < MODES.length; i++) {
            float top = i * (h + gap);
            drawCard(canvas, i, top, h);
        }
    }

    private void drawCard(Canvas canvas, int index, float top, float height) {
        boolean active = index == selected;
        card.set(dp(1), top + dp(1), getWidth() - dp(1), top + height - dp(1));
        paint.setStyle(Paint.Style.FILL);
        paint.setColor(active ? Color.rgb(19, 19, 19) : Color.rgb(12, 12, 12));
        canvas.drawRoundRect(card, dp(16), dp(16), paint);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(active ? 1.5f : 1f));
        paint.setColor(active ? Color.rgb(245, 245, 243) : Color.rgb(45, 45, 45));
        canvas.drawRoundRect(card, dp(16), dp(16), paint);

        paint.setStyle(Paint.Style.FILL);
        paint.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
        paint.setTextSize(sp(14));
        paint.setColor(Color.rgb(245, 245, 243));
        canvas.drawText(getContext().getString(TITLES[index]), dp(14), top + dp(22), paint);
        paint.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        paint.setTextSize(sp(9.5f));
        paint.setColor(Color.rgb(145, 145, 145));
        canvas.drawText(getContext().getString(SUBTITLES[index]), dp(14), top + dp(38), paint);

        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(1));
        paint.setColor(active ? Color.WHITE : Color.rgb(105, 105, 105));
        canvas.drawCircle(getWidth() - dp(20), top + dp(20), dp(7), paint);
        if (active) {
            paint.setStyle(Paint.Style.FILL);
            canvas.drawCircle(getWidth() - dp(20), top + dp(20), dp(3.5f), paint);
        }

        float y = top + dp(72);
        if (index == 2 || index == 3) {
            float[] xs = {dp(27), getWidth() * .35f, getWidth() * .65f, getWidth() - dp(27)};
            drawLinks(canvas, xs, y, active);
            drawNode(canvas, laptop, xs[0], y, getContext().getString(R.string.route_device));
            drawNode(canvas, index == 3 ? tor : relay, xs[1], y,
                    getContext().getString(index == 3 ? R.string.route_tor : R.string.route_nl));
            drawNode(canvas, index == 3 ? tor : relay, xs[2], y,
                    getContext().getString(index == 3 ? R.string.route_onion : R.string.route_de));
            drawNode(canvas, envelope, xs[3], y, getContext().getString(R.string.route_main));
        } else {
            float[] xs = {dp(30), getWidth() / 2f, getWidth() - dp(30)};
            drawLinks(canvas, xs, y, active);
            drawNode(canvas, laptop, xs[0], y, getContext().getString(R.string.route_device));
            drawNode(canvas, relay, xs[1], y, getContext().getString(
                    index == 0 ? R.string.route_best : R.string.route_relay));
            drawNode(canvas, envelope, xs[2], y, getContext().getString(R.string.route_main));
            if (index == 0) drawAutoBadge(canvas, xs[1] + dp(11), y - dp(16));
        }
    }

    private void drawLinks(Canvas canvas, float[] xs, float y, boolean active) {
        for (int i = 0; i < xs.length - 1; i++) {
            float from = xs[i] + dp(16);
            float to = xs[i + 1] - dp(16);
            paint.setStrokeCap(Paint.Cap.ROUND);
            paint.setStrokeWidth(dp(2));
            paint.setColor(active ? Color.rgb(68, 68, 68) : Color.rgb(42, 42, 42));
            canvas.drawLine(from, y, to, y, paint);
            float progress = (phase + i * .19f) % 1f;
            float pulse = dp(14);
            float x = from - pulse + (to - from + pulse * 2) * progress;
            paint.setStrokeWidth(dp(3));
            paint.setColor(active ? Color.WHITE : Color.rgb(155, 155, 155));
            canvas.drawLine(Math.max(from, x), y, Math.min(to, x + pulse), y, paint);
        }
    }

    private void drawNode(Canvas canvas, Drawable icon, float x, float y, String label) {
        int size = dp(27);
        if (icon != null) {
            icon.setBounds(Math.round(x - size / 2f), Math.round(y - size / 2f),
                    Math.round(x + size / 2f), Math.round(y + size / 2f));
            icon.draw(canvas);
        }
        paint.setStyle(Paint.Style.FILL);
        paint.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        paint.setTextSize(sp(7.2f));
        paint.setColor(Color.rgb(118, 118, 118));
        paint.setTextAlign(Paint.Align.CENTER);
        canvas.drawText(label, x, y + dp(24), paint);
        if (label.equals(getContext().getString(R.string.route_nl))) {
            drawFlag(canvas, x + dp(13), y + dp(18), true);
        } else if (label.equals(getContext().getString(R.string.route_de))) {
            drawFlag(canvas, x + dp(13), y + dp(18), false);
        }
        paint.setTextAlign(Paint.Align.LEFT);
    }

    private void drawFlag(Canvas canvas, float x, float y, boolean netherlands) {
        float width = dp(9);
        float band = dp(2.3f);
        int[] colors = netherlands
                ? new int[]{Color.rgb(174, 31, 40), Color.rgb(238, 238, 238), Color.rgb(32, 71, 139)}
                : new int[]{Color.rgb(20, 20, 20), Color.rgb(237, 31, 36), Color.rgb(255, 205, 5)};
        paint.setStyle(Paint.Style.FILL);
        for (int i = 0; i < colors.length; i++) {
            paint.setColor(colors[i]);
            canvas.drawRect(x, y + band * i, x + width, y + band * (i + 1), paint);
        }
    }

    private void drawAutoBadge(Canvas canvas, float x, float y) {
        paint.setColor(Color.WHITE);
        paint.setStyle(Paint.Style.FILL);
        canvas.drawRoundRect(x - dp(10), y - dp(5), x + dp(10), y + dp(4), dp(3), dp(3), paint);
        paint.setColor(Color.BLACK);
        paint.setTextSize(sp(5.5f));
        paint.setTypeface(Typeface.DEFAULT_BOLD);
        paint.setTextAlign(Paint.Align.CENTER);
        canvas.drawText("AUTO", x, y + dp(1.5f), paint);
        paint.setTextAlign(Paint.Align.LEFT);
    }

    @Override public boolean onTouchEvent(MotionEvent event) {
        if (event.getAction() != MotionEvent.ACTION_UP) return true;
        performClick();
        int next = Math.max(0, Math.min(3, (int) (event.getY() / (getHeight() / 4f))));
        if (next != selected) {
            selected = next;
            invalidate();
            if (listener != null) listener.onModeChanged(MODES[selected]);
        }
        return true;
    }

    @Override public boolean performClick() {
        super.performClick();
        return true;
    }

    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private float sp(float value) { return value * getResources().getDisplayMetrics().scaledDensity; }
}
