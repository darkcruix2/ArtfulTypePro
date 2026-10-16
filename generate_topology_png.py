#!/usr/bin/env python3
"""
Generate a beautiful Dracula-themed System Topology diagram for ArtfulType Pro.
"""

from PIL import Image, ImageDraw, ImageFont
import os

width = 920
height = 390

# Dracula Palette
BG = (40, 42, 54)          # #282a36
CURRENT_LINE = (68, 71, 90) # #44475a
FG = (248, 248, 242)        # #f8f8f2
COMMENT = (98, 114, 164)    # #6272a4
CYAN = (139, 233, 253)      # #8be9fd
GREEN = (80, 250, 123)      # #50fa7b
ORANGE = (255, 184, 108)    # #ffb86c
PINK = (255, 121, 198)      # #ff79c6
PURPLE = (189, 147, 249)    # #bd93f9
RED = (255, 85, 85)         # #ff5555
YELLOW = (241, 250, 140)    # #f1fa8c

img = Image.new("RGBA", (width, height), BG)
draw = ImageDraw.Draw(img)

# Outer card border with rounded rectangle
draw.rounded_rectangle([(10, 10), (width - 10, height - 10)], radius=12, outline=CURRENT_LINE, width=2)

# Load font if available, fallback to default
try:
    font_title = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 17)
    font_bold = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 12)
    font_regular = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 11)
    font_badge = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 9)
except Exception:
    font_title = font_bold = font_regular = font_badge = ImageFont.load_default()

# Header banner
draw.text((32, 28), "SYSTEM TOPOLOGY & AUTOMATION PIPELINE", fill=PURPLE, font=font_title)
draw.text((32, 54), "ArtfulType Pro Deployment & Puppet Infrastructure", fill=COMMENT, font=font_regular)

# Nodes definitions (x, y, w, h, title, subtitle, color, badge)
nodes = [
    # Master node
    {"rect": (330, 95, 260, 80), "title": "pp-server.space.mil", "sub": "Puppet Master (CA Server)", "col": PURPLE, "badge": "PORT 8140"},
    # Dev Node
    {"rect": (30, 245, 265, 85), "title": "dev-server.space.mil", "sub": "ArtfulType Desktop (amd64)", "col": GREEN, "badge": "DEBIAN 12"},
    # uConsole Node
    {"rect": (325, 245, 270, 85), "title": "uconsole.space.mil", "sub": "ClockworkPi CM4 (arm64)", "col": CYAN, "badge": "AARCH64"},
    # Windows Node
    {"rect": (625, 245, 265, 85), "title": "pwin01.space.mil", "sub": "Windows 11 Workstation", "col": PINK, "badge": "WIN32 / CLI"}
]

# Draw connection lines from Master (center bottom: 460, 175) to targets
master_pt = (460, 175)
target_pts = [
    (162, 245),  # Dev
    (460, 245),  # uConsole
    (757, 245)   # Win
]

for tpt in target_pts:
    # Line
    draw.line([master_pt, tpt], fill=CURRENT_LINE, width=3)
    # Mid-line connector dot
    mid_x = (master_pt[0] + tpt[0]) // 2
    mid_y = (master_pt[1] + tpt[1]) // 2
    draw.ellipse([mid_x - 3, mid_y - 3, mid_x + 3, mid_y + 3], fill=PURPLE)

# Draw Nodes
for n in nodes:
    rx, ry, rw, rh = n["rect"]
    col = n["col"]
    
    # Node box background
    draw.rounded_rectangle([(rx, ry), (rx + rw, ry + rh)], radius=8, fill=(30, 32, 42), outline=col, width=2)
    
    # Title
    draw.text((rx + 14, ry + 14), n["title"], fill=FG, font=font_bold)
    # Subtitle
    draw.text((rx + 14, ry + 36), n["sub"], fill=COMMENT, font=font_regular)
    
    # Badge at bottom right of card
    bw, bh = 68, 18
    bx = rx + rw - bw - 12
    by = ry + rh - bh - 10
    draw.rounded_rectangle([(bx, by), (bx + bw, by + bh)], radius=4, fill=col)
    # Text inside badge
    draw.text((bx + 6, by + 3), n["badge"], fill=(40, 42, 54), font=font_badge)

# Protocol Labels on arrows
draw.text((225, 200), "mTLS Catalog", fill=COMMENT, font=font_regular)
draw.text((470, 200), ".deb push", fill=COMMENT, font=font_regular)
draw.text((630, 200), "WinRM / SSH", fill=COMMENT, font=font_regular)

# Save images to multiple destination paths
destinations = [
    "/mnt/volume1/MyCode/workspace/ArtfulTypePro/examples/system-topology.png",
    "/mnt/volume1/MyCode/workspace/ArtfulTypePro/system-topology.png",
    "/mnt/volume1/MyCode/workspace/ArtfulTypePro/src/system-topology.png",
    "/mnt/volume1/MyCode/workspace/ArtfulTypePro/assets/system-topology.png"
]

for dest in destinations:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    img.save(dest, "PNG")
    print(f"Saved: {dest}")

print("All PNG assets successfully generated.")
