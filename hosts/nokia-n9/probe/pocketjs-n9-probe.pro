TEMPLATE = app
TARGET = pocketjs-n9-probe
QT += core gui opengl
CONFIG += release meegotouch
CONFIG -= debug app_bundle

SOURCES += main.cpp
QMAKE_CXXFLAGS += -O2 -march=armv7-a -mfpu=neon -mfloat-abi=hard
QMAKE_LFLAGS += -Wl,--no-undefined
LIBS += -lGLESv2 -lEGL

target.path = /opt/pocketjs-n9-probe/bin
desktop.path = /usr/share/applications
desktop.files = pocketjs-n9-probe_harmattan.desktop
icon.path = /usr/share/icons/hicolor/80x80/apps
icon.files = pocketjs-n9-probe.png
INSTALLS += target desktop icon
