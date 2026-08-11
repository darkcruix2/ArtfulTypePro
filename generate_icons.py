import sys
import os
from PIL import Image

def generate_icons(base_icon_path, out_dir):
    img = Image.open(base_icon_path).convert("RGBA")
    
    # Generate PNGs
    sizes = {
        "32x32.png": (32, 32),
        "128x128.png": (128, 128),
        "128x128@2x.png": (256, 256),
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

if __name__ == "__main__":
    generate_icons("src-tauri/icons/icon.png", "src-tauri/icons")
