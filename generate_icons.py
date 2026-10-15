import os
from PIL import Image, ImageDraw

MASTER = "src-tauri/icons/icon_master.png"   # 1024x1024 source artwork
TAURI_ICONS = "src-tauri/icons"
ANDROID_RES = "src-tauri/gen/android/app/src/main/res"


def load_master(path):
    """Load the master artwork and make the area outside the rounded square transparent."""
    img = Image.open(path).convert("RGBA")
    w, h = img.size
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((4, 4, w - 5, h - 5), radius=int(w * 0.17), fill=255)
    img.putalpha(mask)
    return img


def generate_icons(img, out_dir):
    # Generate PNGs
    sizes = {
        "32x32.png": (32, 32),
        "128x128.png": (128, 128),
        "128x128@2x.png": (256, 256),
        "256x256.png": (256, 256),
        "512x512.png": (512, 512),
        "icon.png": (512, 512),
        "Square30x30Logo.png": (30, 30),
        "Square44x44Logo.png": (44, 44),
        "Square71x71Logo.png": (71, 71),
        "Square89x89Logo.png": (89, 89),
        "Square107x107Logo.png": (107, 107),
        "Square142x142Logo.png": (142, 142),
        "Square150x150Logo.png": (150, 150),
        "Square284x284Logo.png": (284, 284),
        "Square310x310Logo.png": (310, 310),
        "StoreLogo.png": (50, 50)
    }

    for name, size in sizes.items():
        resized = img.resize(size, Image.Resampling.LANCZOS)
        resized.save(os.path.join(out_dir, name))

    # Generate ICO
    img.save(os.path.join(out_dir, "icon.ico"), format="ICO", sizes=[(256, 256), (128, 128), (64, 64), (32, 32), (16, 16)])

    # Generate ICNS
    # Note: Pillow supports saving ICNS
    img.save(os.path.join(out_dir, "icon.icns"), format="ICNS")


def generate_android(img, res_dir):
    """Write legacy, round and adaptive-foreground launcher icons for every density."""
    if not os.path.isdir(res_dir):
        return
    densities = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
    for dpi, size in densities.items():
        d = os.path.join(res_dir, "mipmap-" + dpi)
        os.makedirs(d, exist_ok=True)
        icon = img.resize((size, size), Image.Resampling.LANCZOS)
        icon.save(os.path.join(d, "ic_launcher.png"))

        circle = Image.new("L", (size * 4, size * 4), 0)
        ImageDraw.Draw(circle).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
        rnd = icon.copy()
        rnd.putalpha(Image.composite(icon.getchannel("A"),
                                     Image.new("L", icon.size, 0),
                                     circle.resize(icon.size, Image.Resampling.LANCZOS)))
        rnd.save(os.path.join(d, "ic_launcher_round.png"))

        # Adaptive foreground: 108dp canvas, artwork in the 72dp safe zone.
        fg_size = size * 108 // 48
        inner = size * 72 // 48
        fg = Image.new("RGBA", (fg_size, fg_size), (0, 0, 0, 0))
        fg.paste(img.resize((inner, inner), Image.Resampling.LANCZOS),
                 ((fg_size - inner) // 2,) * 2)
        fg.save(os.path.join(d, "ic_launcher_foreground.png"))


if __name__ == "__main__":
    master = load_master(MASTER)
    generate_icons(master, TAURI_ICONS)
    generate_android(master, ANDROID_RES)
