UUID := rdp-activity@bczaplicki
EXTENSION_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
FILES := metadata.json extension.js stylesheet.css README.md

.PHONY: install reinstall uninstall pack

install:
	mkdir -p $(EXTENSION_DIR)
	cp $(FILES) $(EXTENSION_DIR)/

reinstall: uninstall install

uninstall:
	rm -rf $(EXTENSION_DIR)

pack:
	gnome-extensions pack --force --out-dir .
