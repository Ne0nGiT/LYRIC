!macro customInstall
  ; Write the language chosen in the installer so the app opens in the same language (1066 = Vietnamese)
  FileOpen $0 "$INSTDIR\lang.txt" w
  ${If} $LANGUAGE == 1066
    FileWrite $0 "vi"
  ${Else}
    FileWrite $0 "en"
  ${EndIf}
  FileClose $0
!macroend
