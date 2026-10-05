; OrbitCord branding over electron-builder's standard MUI2 wizard.
; Keep the stock dialog geometry on EVERY page. MUI owns layout, DPI scaling,
; bitmap painting, focus, navigation and resource lifetime; do not resize the
; parent or overlay a custom full-window bitmap/button painter here.
!include MUI2.nsh

!define MUI_BGCOLOR "EAF2FF"
!define MUI_TEXTCOLOR "172D50"
!define MUI_INSTFILESPAGE_COLORS "172D50 EAF2FF"
!ifdef BUILD_UNINSTALLER
  !define MUI_CUSTOMFUNCTION_UNGUIINIT un.FrostGUIInit
!else
  !define MUI_CUSTOMFUNCTION_GUIINIT FrostGUIInit
  !define MUI_FINISHPAGE_TITLE "OrbitCord is ready."
  !define MUI_FINISHPAGE_TEXT "Installed successfully. Let the conversation begin.$\r$\n$\r$\nClick Finish to close setup."
  !define MUI_FINISHPAGE_RUN_TEXT "Open OrbitCord"
!endif

!macro customHeader
  BrandingText " "
  !ifndef BUILD_UNINSTALLER
    Caption "OrbitCord"
  !endif
  InstallColors 172D50 EAF2FF
  InstProgressFlags smooth colored
!macroend

!ifdef BUILD_UNINSTALLER
Function un.FrostGUIInit
  SetCtlColors $HWNDPARENT 172D50 EAF2FF
FunctionEnd
!else
Function FrostGUIInit
  SetCtlColors $HWNDPARENT 172D50 EAF2FF
FunctionEnd

!macro customWelcomePage
  !define MUI_PAGE_CUSTOMFUNCTION_PRE FrostWelcomePre
  !define MUI_WELCOMEPAGE_TITLE "Welcome to OrbitCord"
  !define MUI_WELCOMEPAGE_TEXT "A lighter place to hang out.$\r$\n$\r$\nSetup will guide you through installing OrbitCord.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_PAGE_WELCOME

Function FrostWelcomePre
  ; Match electron-builder's update/elevation guards. The standard finish
  ; page retains its StartApp callback (including --updated and runAsUser).
  ${If} ${isUpdated}
    Abort
  ${EndIf}
  ${If} ${UAC_IsInnerInstance}
    Abort
  ${EndIf}
FunctionEnd
!macroend
!endif
