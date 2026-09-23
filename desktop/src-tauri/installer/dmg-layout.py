# dmgbuild settings that produced dmg-DS_Store, the Finder layout of the .dmg
# window: background, window size, icon size and where the two icons sit.
#
# make-dmg.sh never mounts the image (see the comment there), so it can't lay
# the window out itself. It copies dmg-DS_Store in as .DS_Store instead; the
# background is found by its path on a volume named "Gavia".
#
# To change the layout, edit this file and regenerate from desktop/:
#
#   python3 -m venv /tmp/dmgvenv && /tmp/dmgvenv/bin/pip install dmgbuild
#   mkdir -p /tmp/dmg/Gavia.app
#   tiffutil -cathidpicheck src-tauri/installer/dmg-background.png \
#     src-tauri/installer/dmg-background@2x.png -out /tmp/dmg/background.tiff
#   /tmp/dmgvenv/bin/dmgbuild -s src-tauri/installer/dmg-layout.py \
#     -D app=/tmp/dmg/Gavia.app -D background=/tmp/dmg/background.tiff \
#     Gavia /tmp/dmg/layout.dmg
#   hdiutil attach -nobrowse -readonly -mountpoint /tmp/dmg/mnt /tmp/dmg/layout.dmg
#   cp /tmp/dmg/mnt/.DS_Store src-tauri/installer/dmg-DS_Store
#   hdiutil detach /tmp/dmg/mnt
#
# The placeholder Gavia.app is enough: the layout refers to items by name.

format = 'UDRW'
filesystem = 'HFS+'
files = [defines['app']]  # noqa: F821 (provided by dmgbuild)
symlinks = {'Applications': '/Applications'}
background = defines['background']  # noqa: F821
window_rect = ((200, 120), (660, 400))
default_view = 'icon-view'
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
show_icon_preview = False
include_icon_view_settings = True
arrange_by = None
icon_size = 128
text_size = 13
label_pos = 'bottom'
# The loon in the background swims between these, from the app to Applications.
icon_locations = {'Gavia.app': (160, 220), 'Applications': (500, 220)}
