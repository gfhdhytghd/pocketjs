TEMPLATE = app
isEmpty(POCKETJS_N9_TARGET): error(POCKETJS_N9_TARGET is required)
TARGET = $$POCKETJS_N9_TARGET
QT += core gui opengl
CONFIG += release meegotouch
CONFIG -= debug app_bundle

SOURCES += main.cpp
HEADERS += pocketjs_symbian_core.h pocketjs_symbian_extension.h pocketjs_symbian_keys.h pocketjs_n9_build.h
RESOURCES += pocketjs-runtime.qrc

isEmpty(POCKETJS_QUICKJS_INCLUDE): error(POCKETJS_QUICKJS_INCLUDE is required)
isEmpty(POCKETJS_QUICKJS_LIBRARY): error(POCKETJS_QUICKJS_LIBRARY is required)
isEmpty(POCKETJS_CORE_LIBRARY): error(POCKETJS_CORE_LIBRARY is required)
isEmpty(POCKETJS_N9_PACKAGE): error(POCKETJS_N9_PACKAGE is required)

INCLUDEPATH += $$POCKETJS_QUICKJS_INCLUDE
DEFINES += __STDC_LIMIT_MACROS
DEFINES += POCKETJS_HARMATTAN=1
DEFINES += POCKETJS_MAXIMUM_VIEWPORT_EXTENT=854
DEFINES += POCKETJS_FRAME_RATE=60
DEFINES += POCKETJS_HOST_ABI=9
DEFINES += POCKETJS_INITIAL_LOGICAL_WIDTH=854
DEFINES += POCKETJS_INITIAL_LOGICAL_HEIGHT=480
DEFINES += POCKETJS_CAPTURE_FRAME_PERIOD=24

QMAKE_CFLAGS += -O2 -march=armv7-a -mfpu=neon -mfloat-abi=hard
QMAKE_CXXFLAGS += -O2 -march=armv7-a -mfpu=neon -mfloat-abi=hard
QMAKE_LFLAGS += -Wl,--no-undefined

LIBS += $$POCKETJS_QUICKJS_LIBRARY
PRE_TARGETDEPS += $$POCKETJS_QUICKJS_LIBRARY
QMAKE_LFLAGS += -Wl,-u,ui_init -Wl,--whole-archive $$POCKETJS_CORE_LIBRARY -Wl,--no-whole-archive
PRE_TARGETDEPS += $$POCKETJS_CORE_LIBRARY
LIBS += -lGLESv2 -lEGL

target.path = /opt/$$POCKETJS_N9_PACKAGE/bin
desktop.path = /usr/share/applications
desktop.files = $${POCKETJS_N9_PACKAGE}_harmattan.desktop
icon.path = /usr/share/icons/hicolor/80x80/apps
icon.files = $${POCKETJS_N9_PACKAGE}.png
INSTALLS += target desktop icon
