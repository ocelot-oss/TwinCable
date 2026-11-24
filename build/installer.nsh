; twicable's additions to electron-builder's NSIS installer (package.json build.nsis.include).
;
; 1. A second Start menu entry, "twicable (safe graphics)": the app started with --safe-graphics (shared/gpu.mjs) – drawn
;    without the graphics card, for a PC where twicable opens with a blank window. From there Settings › General switches
;    the graphics backend for the next normal start. Created next to the normal entry, removed with the app.
;
; 2. The privacy page (before the install starts): what twicable sends over the internet by itself, what the installer
;    changes on the PC, a link to the full policy (https://souldew.app/privacy.html) and a checkbox for each of the two
;    automatic connections – the anonymous "playing now" count and the update check. Both are ticked as config.json has
;    them (on unless switched off in the app). What the player ticked goes into installer-choices.json in the data folder,
;    which the app applies once at its next start (electron/installerchoices.mjs). The page is never shown – and no file
;    written – for a silent install (/S, the in-app update) or an update started with --updated.
;    It sits in the one-click installer's slot for a license page (oneClick.nsh: skipPageIfUpdated + licensePage), so
;    package.json must not set build.nsis.license (makensis would stop on the second licensePage macro).
;
; 3. Uninstalling by hand (Settings › Apps, the Start menu) asks whether the player's data in %APPDATA%\SoulLink Studio
;    goes too – "No" is the default and keeps it. An update runs the old uninstaller with /S --updated: no question,
;    nothing deleted.
;
; Texts: English, German, French, Spanish and Italian; every other installer language gets the English text (makensis
; runs with -WX, so each string must exist in every language electron-builder bundles – test/installer-privacy.test.mjs).

!include LogicLib.nsh
!include FileFunc.nsh
!include nsDialogs.nsh

; the data folder (electron/main.mjs: userData = %APPDATA%\SoulLink Studio)
!define SD_DATA_DIR "$APPDATA\SoulLink Studio"
!define SD_POLICY_URL "https://souldew.app/privacy.html"

; One text in all of electron-builder's installer languages: EN DE FR ES IT, English for the rest.
!macro SD_STR NAME EN DE FR ES IT
  LangString ${NAME} 1033 "${EN}"
  LangString ${NAME} 1031 "${DE}"
  LangString ${NAME} 1036 "${FR}"
  LangString ${NAME} 3082 "${ES}"
  LangString ${NAME} 1040 "${IT}"
  ; zh_CN zh_TW ja_JP ko_KR nl_NL da_DK sv_SE nb_NO fi_FI ru_RU pt_PT pt_BR pl_PL uk_UA cs_CZ sk_SK hu_HU ar_SA tr_TR th_TH vi_VN
  LangString ${NAME} 2052 "${EN}"
  LangString ${NAME} 1028 "${EN}"
  LangString ${NAME} 1041 "${EN}"
  LangString ${NAME} 1042 "${EN}"
  LangString ${NAME} 1043 "${EN}"
  LangString ${NAME} 1030 "${EN}"
  LangString ${NAME} 1053 "${EN}"
  LangString ${NAME} 1044 "${EN}"
  LangString ${NAME} 1035 "${EN}"
  LangString ${NAME} 1049 "${EN}"
  LangString ${NAME} 2070 "${EN}"
  LangString ${NAME} 1046 "${EN}"
  LangString ${NAME} 1045 "${EN}"
  LangString ${NAME} 1058 "${EN}"
  LangString ${NAME} 1029 "${EN}"
  LangString ${NAME} 1051 "${EN}"
  LangString ${NAME} 1038 "${EN}"
  LangString ${NAME} 1025 "${EN}"
  LangString ${NAME} 1055 "${EN}"
  LangString ${NAME} 1054 "${EN}"
  LangString ${NAME} 1066 "${EN}"
!macroend

!ifndef BUILD_UNINSTALLER
; ---- the privacy page ---------------------------------------------------------------------------------------------

!insertmacro SD_STR sdPrivTitle "Privacy" "Datenschutz" "Confidentialité" "Privacidad" "Privacy"
!insertmacro SD_STR sdPrivSub \
  "What twicable sends over the internet by itself" \
  "Was twicable von selbst über das Internet sendet" \
  "Ce que twicable envoie de lui-même sur Internet" \
  "Lo que twicable envía por sí solo a través de internet" \
  "Cosa invia twicable da solo tramite internet"
!insertmacro SD_STR sdPrivIntro \
  "twicable collects no personal data. Only the two things ticked below go out by themselves – switch them off here or later in twicable’s settings." \
  "twicable sammelt keine persönlichen Daten. Von selbst geht nur das, was unten angehakt ist – hier oder später in den Einstellungen von twicable abschaltbar." \
  "twicable ne collecte aucune donnée personnelle. Seul ce qui est coché ci-dessous part de lui-même – désactivable ici ou plus tard dans les paramètres de twicable." \
  "twicable no recoge datos personales. Solo sale por sí solo lo que está marcado abajo: puedes desactivarlo aquí o más tarde en los ajustes de twicable." \
  "twicable non raccoglie dati personali. Parte da solo soltanto ciò che è spuntato qui sotto – puoi disattivarlo qui o più tardi nelle impostazioni di twicable."
!insertmacro SD_STR sdPol1 \
  "“PLAYING NOW” COUNT (anonymous)$\r$\nOnly while a game runs in twicable’s own player, about once a minute: the system (e.g. GBA), the mode (solo, Nuzlocke, SoulLink or Play together), the twicable version and a random id that is new for every game – to api.souldew.app, for the player count on the twicable Discord. No name, no account, no game title, nothing about your PC; your IP address is not stored. Once a day it also counts that twicable was used, for the team’s statistics: version, system, processor, the week of first use and on how many recent days twicable ran – with a random value that is new every day. Settings › Online." \
  "„SPIELT GERADE“-ZÄHLER (anonym)$\r$\nNur während ein Spiel in twicables eigenem Player läuft, etwa einmal pro Minute: das System (z. B. GBA), der Modus (Solo, Nuzlocke, SoulLink oder Zusammen spielen), die twicable-Version und eine Zufalls-ID, die für jedes Spiel neu ist – an api.souldew.app, für die Spielerzahl im twicable-Discord. Kein Name, kein Konto, kein Spieltitel, nichts über deinen PC; deine IP-Adresse wird nicht gespeichert. Einmal am Tag wird außerdem gezählt, dass twicable benutzt wurde, für die Statistik des Teams: Version, System, Prozessor, die Woche der ersten Nutzung und an wie vielen der letzten Tage twicable lief – mit einem Zufallswert, der jeden Tag neu ist. Einstellungen › Online." \
  "COMPTEUR « JOUE EN CE MOMENT » (anonyme)$\r$\nUniquement pendant qu’un jeu tourne dans le lecteur de twicable, environ une fois par minute : le système (p. ex. GBA), le mode (solo, Nuzlocke, SoulLink ou Jouer ensemble), la version de twicable et un identifiant aléatoire, nouveau pour chaque partie – vers api.souldew.app, pour le nombre de joueurs sur le Discord de twicable. Ni nom, ni compte, ni titre de jeu, rien sur ton PC ; ton adresse IP n’est pas enregistrée. Une fois par jour, twicable compte aussi qu’il a été utilisé, pour les statistiques de l’équipe : version, système, processeur, la semaine de première utilisation et le nombre de jours récents où twicable a tourné – avec une valeur aléatoire nouvelle chaque jour. Paramètres › En ligne." \
  "CONTADOR «JUGANDO AHORA» (anónimo)$\r$\nSolo mientras un juego está en marcha en el reproductor de twicable, más o menos una vez por minuto: el sistema (p. ej. GBA), el modo (solo, Nuzlocke, SoulLink o Jugar juntos), la versión de twicable y un id aleatorio, nuevo para cada partida, a api.souldew.app, para el contador de jugadores del Discord de twicable. Sin nombre, sin cuenta, sin título del juego, nada sobre tu PC; tu dirección IP no se guarda. Una vez al día también cuenta que se usó twicable, para las estadísticas del equipo: versión, sistema, procesador, la semana del primer uso y en cuántos de los últimos días se usó twicable, con un valor aleatorio nuevo cada día. Ajustes › En línea." \
  "CONTATORE «STA GIOCANDO ORA» (anonimo)$\r$\nSolo mentre un gioco è in corso nel lettore di twicable, circa una volta al minuto: il sistema (ad es. GBA), la modalità (solo, Nuzlocke, SoulLink o Giocare insieme), la versione di twicable e un id casuale, nuovo per ogni partita – ad api.souldew.app, per il conteggio dei giocatori sul Discord di twicable. Nessun nome, nessun account, nessun titolo del gioco, niente sul tuo PC; il tuo indirizzo IP non viene salvato. Una volta al giorno conta anche che twicable è stato usato, per le statistiche del team: versione, sistema, processore, la settimana del primo utilizzo e in quanti degli ultimi giorni twicable è stato usato – con un valore casuale nuovo ogni giorno. Impostazioni › Online."
!insertmacro SD_STR sdPol2 \
  "UPDATE CHECK$\r$\nAt start and every 4 hours twicable asks GitHub (github.com/souldewapp/souldew) whether there is a new version. Nothing about you is sent. When switched off, twicable only checks when you click “Check for updates” (Settings › About)." \
  "UPDATE-PRÜFUNG$\r$\nBeim Start und alle 4 Stunden fragt twicable bei GitHub (github.com/souldewapp/souldew) nach, ob es eine neue Version gibt. Dabei wird nichts über dich gesendet. Ausgeschaltet sucht twicable nur, wenn du auf „Nach Updates suchen“ klickst (Einstellungen › Info)." \
  "RECHERCHE DE MISES À JOUR$\r$\nAu démarrage puis toutes les 4 heures, twicable demande à GitHub (github.com/souldewapp/souldew) s’il existe une nouvelle version. Rien sur toi n’est envoyé. Désactivée, twicable ne cherche que lorsque tu cliques sur « Rechercher des mises à jour » (Paramètres › À propos)." \
  "BÚSQUEDA DE ACTUALIZACIONES$\r$\nAl iniciar y cada 4 horas, twicable pregunta a GitHub (github.com/souldewapp/souldew) si hay una versión nueva. No se envía nada sobre ti. Desactivada, twicable solo busca cuando pulsas «Buscar actualizaciones» (Ajustes › Acerca de)." \
  "CONTROLLO AGGIORNAMENTI$\r$\nAll’avvio e ogni 4 ore twicable chiede a GitHub (github.com/souldewapp/souldew) se c’è una nuova versione. Non viene inviato nulla su di te. Se disattivato, twicable controlla solo quando clicchi su «Cerca aggiornamenti» (Impostazioni › Info)."
!insertmacro SD_STR sdPol3 \
  "PICTURES$\r$\nPokémon pictures and game covers are downloaded from public GitHub repositories (PokeAPI, libretro-thumbnails) and kept on this PC; the twicable+ preview pictures come from accounts.souldew.app. These downloads carry nothing about you." \
  "BILDER$\r$\nPokémon-Bilder und Spiele-Cover werden aus öffentlichen GitHub-Repositorys (PokeAPI, libretro-thumbnails) geladen und auf diesem PC gespeichert; die Vorschaubilder von twicable+ kommen von accounts.souldew.app. Diese Downloads enthalten nichts über dich." \
  "IMAGES$\r$\nLes images de Pokémon et les jaquettes des jeux sont téléchargées depuis des dépôts GitHub publics (PokeAPI, libretro-thumbnails) et gardées sur ce PC ; les aperçus de twicable+ viennent de accounts.souldew.app. Ces téléchargements ne contiennent rien sur toi." \
  "IMÁGENES$\r$\nLas imágenes de Pokémon y las portadas de los juegos se descargan de repositorios públicos de GitHub (PokeAPI, libretro-thumbnails) y se guardan en este PC; las vistas previas de twicable+ vienen de accounts.souldew.app. Estas descargas no contienen nada sobre ti." \
  "IMMAGINI$\r$\nLe immagini dei Pokémon e le copertine dei giochi vengono scaricate da repository GitHub pubblici (PokeAPI, libretro-thumbnails) e conservate su questo PC; le anteprime di twicable+ arrivano da accounts.souldew.app. Questi download non contengono nulla su di te."
!insertmacro SD_STR sdPol4 \
  "ONLY WHEN YOU USE THEM$\r$\nPlaying together (encrypted run data through public relays, then directly between the players), the twicable account and twicable+ (once you sign in), Discord live runs and webhooks you set up, and downloading the randomizer or an emulator connect only when you use them, and send only what they need." \
  "NUR WENN DU SIE NUTZT$\r$\nZusammen spielen (verschlüsselte Run-Daten über öffentliche Relays, dann direkt zwischen den Spielern), das twicable-Konto und twicable+ (sobald du dich anmeldest), Discord-Live-Runs und Webhooks, die du einrichtest, sowie der Download des Randomizers oder eines Emulators verbinden sich nur, wenn du sie nutzt, und senden nur, was sie brauchen." \
  "SEULEMENT QUAND TU LES UTILISES$\r$\nJouer ensemble (données de run chiffrées via des relais publics, puis directement entre les joueurs), le compte twicable et twicable+ (dès que tu te connectes), les Live Runs Discord et les webhooks que tu configures, ainsi que le téléchargement du randomizer ou d’un émulateur ne se connectent que quand tu les utilises, et n’envoient que ce dont ils ont besoin." \
  "SOLO CUANDO LOS USAS$\r$\nJugar juntos (datos de la partida cifrados a través de relés públicos y luego directamente entre los jugadores), la cuenta de twicable y twicable+ (en cuanto inicias sesión), los Live Runs de Discord y los webhooks que configuras, y la descarga del randomizer o de un emulador solo se conectan cuando los usas, y solo envían lo que necesitan." \
  "SOLO QUANDO LI USI$\r$\nGiocare insieme (dati della run cifrati tramite relay pubblici, poi direttamente tra i giocatori), l’account twicable e twicable+ (appena accedi), le Live Run di Discord e i webhook che configuri, e il download del randomizer o di un emulatore si connettono solo quando li usi, e inviano solo ciò che serve."
!insertmacro SD_STR sdPol5 \
  "WHAT THIS INSTALLER CHANGES$\r$\ntwicable is installed for you only, without administrator rights, in %LOCALAPPDATA%\Programs\twicable. It adds “twicable” and “twicable (safe graphics)” to the Start menu, a desktop shortcut, and an entry under Settings › Apps to uninstall it. No file types, no web links, no services, no autostart. Your data stays in %APPDATA%\SoulLink Studio – uninstalling asks whether to delete it." \
  "WAS DIESES SETUP VERÄNDERT$\r$\ntwicable wird nur für dich installiert, ohne Administratorrechte, in %LOCALAPPDATA%\Programs\twicable. Es legt „twicable“ und „twicable (safe graphics)“ im Startmenü an, eine Verknüpfung auf dem Desktop und einen Eintrag unter Einstellungen › Apps zum Deinstallieren. Keine Dateitypen, keine Weblinks, keine Dienste, kein Autostart. Deine Daten bleiben in %APPDATA%\SoulLink Studio – beim Deinstallieren wirst du gefragt, ob sie gelöscht werden sollen." \
  "CE QUE CET INSTALLATEUR MODIFIE$\r$\ntwicable est installé pour toi seul, sans droits d’administrateur, dans %LOCALAPPDATA%\Programs\twicable. Il ajoute « twicable » et « twicable (safe graphics) » au menu Démarrer, un raccourci sur le bureau et une entrée dans Paramètres › Applications pour le désinstaller. Aucun type de fichier, aucun lien web, aucun service, aucun démarrage automatique. Tes données restent dans %APPDATA%\SoulLink Studio – la désinstallation demande s’il faut les supprimer." \
  "QUÉ CAMBIA ESTE INSTALADOR$\r$\ntwicable se instala solo para ti, sin derechos de administrador, en %LOCALAPPDATA%\Programs\twicable. Añade «twicable» y «twicable (safe graphics)» al menú Inicio, un acceso directo en el escritorio y una entrada en Configuración › Aplicaciones para desinstalarlo. Ningún tipo de archivo, ningún enlace web, ningún servicio, ningún inicio automático. Tus datos se quedan en %APPDATA%\SoulLink Studio; al desinstalar se te pregunta si quieres borrarlos." \
  "COSA CAMBIA QUESTO INSTALLER$\r$\ntwicable viene installato solo per te, senza diritti di amministratore, in %LOCALAPPDATA%\Programs\twicable. Aggiunge «twicable» e «twicable (safe graphics)» al menu Start, un collegamento sul desktop e una voce in Impostazioni › App per disinstallarlo. Nessun tipo di file, nessun link web, nessun servizio, nessun avvio automatico. I tuoi dati restano in %APPDATA%\SoulLink Studio – disinstallando ti viene chiesto se eliminarli."
!insertmacro SD_STR sdChkPresence \
  "Count me in “playing now” (anonymous)" \
  "Bei „Spielt gerade“ mitzählen (anonym)" \
  "Me compter dans « joue en ce moment » (anonyme)" \
  "Contarme en «jugando ahora» (anónimo)" \
  "Contami in «sta giocando ora» (anonimo)"
!insertmacro SD_STR sdChkUpdates \
  "Check for updates automatically" \
  "Automatisch nach Updates suchen" \
  "Rechercher automatiquement les mises à jour" \
  "Buscar actualizaciones automáticamente" \
  "Cerca aggiornamenti automaticamente"
!insertmacro SD_STR sdPolicyLink \
  "Read the full privacy policy (souldew.app/privacy.html)" \
  "Ganze Datenschutzerklärung lesen (souldew.app/privacy.html)" \
  "Lire la politique de confidentialité complète (souldew.app/privacy.html)" \
  "Leer la política de privacidad completa (souldew.app/privacy.html)" \
  "Leggi l’informativa sulla privacy completa (souldew.app/privacy.html)"

Var sdPrivacyShown ; "1" once the player left the page with "Install"
Var sdPresence ; "true" / "false": the boxes when "Install" was clicked …
Var sdUpdateCheck
Var sdPresenceShown ; … and when the page opened (config.json's state)
Var sdUpdateCheckShown
Var sdChkPresence
Var sdChkUpdate

; config.json's state of the two settings: off only when switched off ("presence": false / "updateCheck": false as a
; top-level key – the app writes the file with two-space indentation, one key per line)
Function sdReadConfig
  StrCpy $sdPresenceShown "true"
  StrCpy $sdUpdateCheckShown "true"
  ClearErrors
  FileOpen $0 "${SD_DATA_DIR}\config.json" r
  ${IfNot} ${Errors}
    ${Do}
      ClearErrors
      FileRead $0 $1
      ${If} ${Errors}
        ${ExitDo}
      ${EndIf}
      StrCpy $2 $1 19
      ${If} $2 == '  "presence": false'
        StrCpy $sdPresenceShown "false"
      ${EndIf}
      StrCpy $2 $1 22
      ${If} $2 == '  "updateCheck": false'
        StrCpy $sdUpdateCheckShown "false"
      ${EndIf}
    ${Loop}
    FileClose $0
  ${EndIf}
FunctionEnd

Function sdOpenPolicy
  Pop $0 ; the link's window
  ExecShell "open" "${SD_POLICY_URL}"
FunctionEnd

; oneClick.nsh inserts this (after skipPageIfUpdated) right before the install starts.
!macro licensePage
  ; skipPageIfUpdated defined MUI_PAGE_CUSTOMFUNCTION_PRE for the next MUI page – a plain custom page doesn't use it, and
  ; left defined it would go to MUI_PAGE_INSTFILES and skip the install itself on an update. The page skips itself.
  !ifdef MUI_PAGE_CUSTOMFUNCTION_PRE
    !define SD_SKIP_FN ${MUI_PAGE_CUSTOMFUNCTION_PRE}
    !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !endif

  Function sdPrivacyCreate
    !ifdef SD_SKIP_FN
      GetFunctionAddress $0 ${SD_SKIP_FN} ; (referenced, so makensis -WX doesn't stop on an unused function)
    !endif
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    ${If} $sdPresenceShown == ""
      ${If} $installMode == "all"
        SetShellVarContext current
      ${EndIf}
      Call sdReadConfig
      ${If} $installMode == "all"
        SetShellVarContext all
      ${EndIf}
      StrCpy $sdPresence $sdPresenceShown
      StrCpy $sdUpdateCheck $sdUpdateCheckShown
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "$(sdPrivTitle)" "$(sdPrivSub)"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 20u "$(sdPrivIntro)"
    Pop $0
    ; the policy itself, read-only and scrollable
    nsDialogs::CreateControl EDIT ${DEFAULT_STYLES}|${WS_TABSTOP}|${WS_VSCROLL}|${ES_MULTILINE}|${ES_READONLY}|${ES_AUTOVSCROLL} ${WS_EX_CLIENTEDGE} 0 22u 100% 72u ""
    Pop $0
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(sdPol1)$\r$\n$\r$\n$(sdPol2)$\r$\n$\r$\n$(sdPol3)$\r$\n$\r$\n$(sdPol4)$\r$\n$\r$\n$(sdPol5)"

    ${NSD_CreateCheckBox} 0 97u 100% 11u "$(sdChkPresence)"
    Pop $sdChkPresence
    ${If} $sdPresence == "true"
      ${NSD_Check} $sdChkPresence
    ${EndIf}
    ${NSD_CreateCheckBox} 0 109u 100% 11u "$(sdChkUpdates)"
    Pop $sdChkUpdate
    ${If} $sdUpdateCheck == "true"
      ${NSD_Check} $sdChkUpdate
    ${EndIf}

    ${NSD_CreateLink} 0 125u 100% 11u "$(sdPolicyLink)"
    Pop $0
    ${NSD_OnClick} $0 sdOpenPolicy

    ; the next step is the install itself
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(^InstallBtn)"
    nsDialogs::Show
  FunctionEnd

  Function sdPrivacyLeave
    ${NSD_GetState} $sdChkPresence $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $sdPresence "true"
    ${Else}
      StrCpy $sdPresence "false"
    ${EndIf}
    ${NSD_GetState} $sdChkUpdate $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $sdUpdateCheck "true"
    ${Else}
      StrCpy $sdUpdateCheck "false"
    ${EndIf}
    StrCpy $sdPrivacyShown "1"
  FunctionEnd

  Page custom sdPrivacyCreate sdPrivacyLeave
!macroend

; The choices for the app (electron/installerchoices.mjs) – only when the page was shown and left with "Install".
!macro sdWriteChoices
  ${If} $sdPrivacyShown == "1"
    ${If} $installMode == "all"
      SetShellVarContext current
    ${EndIf}
    CreateDirectory "${SD_DATA_DIR}"
    ClearErrors
    FileOpen $0 "${SD_DATA_DIR}\installer-choices.json" w
    ${IfNot} ${Errors}
      FileWrite $0 '{"v":1,"presence":$sdPresence,"presenceShown":$sdPresenceShown,"updateCheck":$sdUpdateCheck,"updateCheckShown":$sdUpdateCheckShown}'
      FileClose $0
    ${EndIf}
    ClearErrors
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
  ${EndIf}
!macroend
!endif

!ifdef BUILD_UNINSTALLER
!insertmacro SD_STR sdUnDeleteData \
  "Also delete your twicable data?$\r$\n$\r$\nYour runs, saves, save states, settings, trophies and the games in the twicable library are in %APPDATA%\SoulLink Studio.$\r$\n$\r$\nNo: they stay on this PC, and installing twicable again picks them up.$\r$\nYes: that folder is deleted for good." \
  "Auch deine twicable-Daten löschen?$\r$\n$\r$\nDeine Runs, Spielstände, Savestates, Einstellungen, Trophäen und die Spiele in der twicable-Bibliothek liegen in %APPDATA%\SoulLink Studio.$\r$\n$\r$\nNein: Sie bleiben auf diesem PC, und eine neue Installation findet sie wieder.$\r$\nJa: Dieser Ordner wird endgültig gelöscht." \
  "Supprimer aussi tes données twicable ?$\r$\n$\r$\nTes runs, sauvegardes, états de sauvegarde, paramètres, trophées et les jeux de la bibliothèque twicable se trouvent dans %APPDATA%\SoulLink Studio.$\r$\n$\r$\nNon : elles restent sur ce PC, et une nouvelle installation les retrouve.$\r$\nOui : ce dossier est supprimé définitivement." \
  "¿Borrar también tus datos de twicable?$\r$\n$\r$\nTus runs, partidas guardadas, estados guardados, ajustes, trofeos y los juegos de la biblioteca de twicable están en %APPDATA%\SoulLink Studio.$\r$\n$\r$\nNo: se quedan en este PC y una nueva instalación los vuelve a encontrar.$\r$\nSí: esa carpeta se borra para siempre." \
  "Eliminare anche i tuoi dati di twicable?$\r$\n$\r$\nLe tue run, i salvataggi, gli stati salvati, le impostazioni, i trofei e i giochi della libreria di twicable si trovano in %APPDATA%\SoulLink Studio.$\r$\n$\r$\nNo: restano su questo PC e una nuova installazione li ritrova.$\r$\nSì: quella cartella viene eliminata definitivamente."

Var sdDeleteData ; "1": the player said yes to deleting the data folder

; After the one-click uninstaller's "Are you sure …?" (un.onInit): only an uninstall by hand asks – not /S (an update runs
; the old uninstaller with /S --updated, Windows' "quiet uninstall" with /S) and not --updated. "No" is the default.
!macro customUnInit
  StrCpy $sdDeleteData "0"
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/S" $R1
  ${If} ${Errors}
  ${AndIfNot} ${isUpdated}
    SetShellVarContext current
    ${If} ${FileExists} "${SD_DATA_DIR}\*.*"
      ; the one-click uninstaller has already switched itself to silent (after its "Are you sure …?"), and a silent
      ; MessageBox answers /SD on its own without showing – so speak up for this one question, then back to silent
      SetSilent normal
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$(sdUnDeleteData)" /SD IDNO IDNO +2
      StrCpy $sdDeleteData "1"
      SetSilent silent
    ${EndIf}
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
  ${EndIf}
  ClearErrors
!macroend
!endif

!macro customInstall
  CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME} (safe graphics).lnk" "$appExe" "--safe-graphics" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "$SMPROGRAMS\${SHORTCUT_NAME} (safe graphics).lnk" "${APP_ID}"
  ClearErrors
  !insertmacro sdWriteChoices
!macroend

!macro customUnInstall
  ; an update uninstalls the old version first and installs the shortcut again right after
  WinShell::UninstShortcut "$SMPROGRAMS\${SHORTCUT_NAME} (safe graphics).lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_NAME} (safe graphics).lnk"
  ClearErrors
  ; the player's data – only after a "Yes" to the question above (never on an update)
  ${If} $sdDeleteData == "1"
    SetShellVarContext current
    RMDir /r "${SD_DATA_DIR}"
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
    ClearErrors
  ${EndIf}
!macroend
