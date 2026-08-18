#include <MApplication>
#include <MExport>
#include <MWindow>
#include <QBasicTimer>
#include <QEvent>
#include <QTimerEvent>
#include <QTouchEvent>
#include <QtOpenGL/QGLWidget>

#include <GLES2/gl2.h>

QGLFormat pocketN9ProbeFormat()
{
    QGLFormat format;
    format.setRgba(true);
    format.setDoubleBuffer(true);
    format.setDepth(false);
    format.setStencil(false);
    format.setSampleBuffers(false);
    format.setSwapInterval(1);
    return format;
}

class PocketN9ProbeSurface : public QGLWidget
{
public:
    PocketN9ProbeSurface()
        : QGLWidget(pocketN9ProbeFormat()), frames_(0), active_(true)
    {
        setAttribute(Qt::WA_AcceptTouchEvents, true);
        setAttribute(Qt::WA_OpaquePaintEvent, true);
        setAutoBufferSwap(false);
        frameTimer_.start(0, this);
    }

    void setDisplayActive(bool active) { active_ = active; }

protected:
    void initializeGL()
    {
        const char *version = reinterpret_cast<const char *>(glGetString(GL_VERSION));
        const char *vendor = reinterpret_cast<const char *>(glGetString(GL_VENDOR));
        const char *renderer = reinterpret_cast<const char *>(glGetString(GL_RENDERER));
        qWarning(
            "PocketJS N9 probe: GLES=%s vendor=%s renderer=%s size=%dx%d swap=%d",
            version == 0 ? "unknown" : version,
            vendor == 0 ? "unknown" : vendor,
            renderer == 0 ? "unknown" : renderer,
            width(),
            height(),
            format().swapInterval()
        );
    }

    void paintGL()
    {
        const float pulse = static_cast<float>(frames_ % 120) / 119.0f;
        glViewport(0, 0, width(), height());
        glClearColor(0.02f, 0.2f + pulse * 0.25f, 0.45f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT);
        ++frames_;
    }

    void timerEvent(QTimerEvent *event)
    {
        if (event->timerId() == frameTimer_.timerId() && active_) {
            updateGL();
            swapBuffers();
            return;
        }
        QGLWidget::timerEvent(event);
    }

    bool event(QEvent *event)
    {
        if (event->type() == QEvent::TouchBegin ||
            event->type() == QEvent::TouchUpdate ||
            event->type() == QEvent::TouchEnd) {
            QTouchEvent *touch = static_cast<QTouchEvent *>(event);
            qWarning(
                "PocketJS N9 probe: touch type=%d contacts=%d",
                static_cast<int>(event->type()),
                touch->touchPoints().size()
            );
            event->accept();
            return true;
        }
        return QGLWidget::event(event);
    }

private:
    QBasicTimer frameTimer_;
    unsigned int frames_;
    bool active_;
};

class PocketN9ProbeWindow : public MWindow
{
    Q_OBJECT
public:
    explicit PocketN9ProbeWindow(PocketN9ProbeSurface *surface)
        : MWindow(), surface_(surface)
    {
        setViewport(surface_);
        setOrientationLocked(false);
        setOrientationAngleLocked(false);
        connect(
            this,
            SIGNAL(orientationAngleChanged(M::OrientationAngle)),
            this,
            SLOT(orientationStarted(M::OrientationAngle))
        );
        connect(
            this,
            SIGNAL(orientationChangeFinished(M::Orientation)),
            this,
            SLOT(orientationFinished(M::Orientation))
        );
        connect(this, SIGNAL(displayEntered()), this, SLOT(displayEnteredSlot()));
        connect(this, SIGNAL(displayExited()), this, SLOT(displayExitedSlot()));
        connect(this, SIGNAL(switcherEntered()), this, SLOT(displayExitedSlot()));
        connect(this, SIGNAL(switcherExited()), this, SLOT(displayEnteredSlot()));
    }

private slots:
    void orientationStarted(M::OrientationAngle angle)
    {
        surface_->setDisplayActive(false);
        qWarning(
            "PocketJS N9 probe: rotation begin angle=%d scene=%dx%d surface=%dx%d",
            static_cast<int>(angle),
            visibleSceneSize().width(),
            visibleSceneSize().height(),
            surface_->width(),
            surface_->height()
        );
    }

    void orientationFinished(M::Orientation orientation)
    {
        qWarning(
            "PocketJS N9 probe: rotation end orientation=%d angle=%d scene=%dx%d surface=%dx%d",
            static_cast<int>(orientation),
            static_cast<int>(orientationAngle()),
            visibleSceneSize().width(),
            visibleSceneSize().height(),
            surface_->width(),
            surface_->height()
        );
        surface_->setDisplayActive(true);
    }

    void displayEnteredSlot()
    {
        qWarning("PocketJS N9 probe: display entered");
        surface_->setDisplayActive(true);
    }

    void displayExitedSlot()
    {
        qWarning("PocketJS N9 probe: display exited");
        surface_->setDisplayActive(false);
    }

private:
    PocketN9ProbeSurface *surface_;
};

M_EXPORT int main(int argc, char *argv[])
{
    MApplication application(argc, argv);
    PocketN9ProbeSurface *surface = new PocketN9ProbeSurface();
    PocketN9ProbeWindow window(surface);
    window.showFullScreen();
    surface->setFocus();
    return application.exec();
}

#include "main.moc"
