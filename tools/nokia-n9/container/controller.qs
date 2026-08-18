function Controller() {
    installer.setMessageBoxAutomaticAnswer("installationErrorWithRetry", QMessageBox.Ignore);
}

Controller.prototype.IntroductionPageCallback = function() {
    gui.clickButton(buttons.NextButton);
};

Controller.prototype.TargetDirectoryPageCallback = function() {
    gui.currentPageWidget().TargetDirectoryLineEdit.setText("/toolchain/QtSDK");
    gui.clickButton(buttons.NextButton);
};

Controller.prototype.PackageManagerSelectedCallback = function() {
    var page = gui.pageWidgetByObjectName("DynamicInstallationKindWidget");
    if (page == null) page = gui.pageWidgetByObjectName("InstallationKindWidget");
    if (page != null && page.CustomRadioButton != null) {
        page.CustomRadioButton.setChecked(true);
        gui.clickButton(buttons.NextButton);
    }
};

Controller.prototype.ComponentSelectionPageCallback = function() {
    var page = gui.currentPageWidget();
    page.deselectAll();
    var components = [
        "com.nokia.ndk.tools.madde.application",
        "com.nokia.ndk.tools.madde.qttools.474",
        "com.nokia.ndk.tools.madde.toolchains.2009q367",
        "com.nokia.ndk.tools.harmattan.sysroot",
        "com.nokia.ndk.tools.harmattan"
    ];
    for (var index = 0; index < components.length; ++index) {
        installer.selectComponent(components[index]);
    }
    gui.clickButton(buttons.NextButton);
};

Controller.prototype.LicenseAgreementPageCallback = function() {
    var page = gui.currentPageWidget();
    if (page.AcceptLicenseRadioButton) page.AcceptLicenseRadioButton.setChecked(true);
    gui.clickButton(buttons.NextButton);
};

Controller.prototype.StartMenuDirectoryPageCallback = function() {
    gui.clickButton(buttons.NextButton);
};

Controller.prototype.ReadyForInstallationPageCallback = function() {
    gui.clickButton(buttons.CommitButton);
};

Controller.prototype.FinishedPageCallback = function() {
    var page = gui.currentPageWidget();
    if (page.RunItCheckBox) page.RunItCheckBox.setChecked(false);
    gui.clickButton(buttons.FinishButton);
};
