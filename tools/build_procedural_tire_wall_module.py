import math
import random
import sys
from pathlib import Path

import bpy


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "assets" / "models" / "scenic"
DOCS_DIR = ROOT / "docs" / "images"
BLEND_OUT = OUT_DIR / "procedural_tire_wall_module.blend"
GLB_OUT = OUT_DIR / "procedural_tire_wall_module.glb"
PREVIEW_OUT = DOCS_DIR / "procedural-tire-wall-preview.png"


def clean_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()


def make_mat(name, color, roughness=0.82):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = 0
    return mat


def add_torus(name, loc, major, minor, mat, seg=96, tube=20):
    bpy.ops.mesh.primitive_torus_add(
        major_segments=seg,
        minor_segments=tube,
        major_radius=major,
        minor_radius=minor,
        location=loc,
    )
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    obj.modifiers.new("soft tire normals", "WEIGHTED_NORMAL")
    return obj


def add_cylinder(name, loc, radius, depth, mat, vertices=64):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    obj.modifiers.new("soft cylinder normals", "WEIGHTED_NORMAL")
    return obj


def add_flat_tire_body(name, x, y, z, paint_mat, outer_mat, inner_mat, scale=1.0):
    seg = 128
    s = scale
    profile = [
        (0.255 * s, 0.090 * s),
        (0.315 * s, 0.135 * s),
        (0.430 * s, 0.150 * s),
        (0.535 * s, 0.120 * s),
        (0.585 * s, 0.040 * s),
        (0.585 * s, -0.060 * s),
        (0.535 * s, -0.128 * s),
        (0.420 * s, -0.148 * s),
        (0.315 * s, -0.132 * s),
        (0.255 * s, -0.090 * s),
    ]
    verts = []
    uvs = []
    faces = []
    material_indices = []
    for i in range(seg):
        a = (i / seg) * math.tau
        ca = math.cos(a)
        sa = math.sin(a)
        wobble = 1.0 + 0.006 * math.sin(a * 5.0) + 0.004 * math.sin(a * 11.0)
        for j, (r, pz) in enumerate(profile):
            verts.append((x + ca * r * wobble, y + sa * r * wobble, z + pz))
            uvs.append((i / seg, j / (len(profile) - 1)))

    count = len(profile)
    for i in range(seg):
        ni = (i + 1) % seg
        for j in range(count - 1):
            faces.append((i * count + j, ni * count + j, ni * count + j + 1, i * count + j + 1))
            if j in (0, count - 2):
                material_indices.append(2)
            elif j in (3, 4, 5):
                material_indices.append(1)
            else:
                material_indices.append(0)
        faces.append((i * count + count - 1, ni * count + count - 1, ni * count, i * count))
        material_indices.append(2)

    mesh = bpy.data.meshes.new(f"{name}Mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(paint_mat)
    obj.data.materials.append(outer_mat)
    obj.data.materials.append(inner_mat)
    for poly, mat_index in zip(mesh.polygons, material_indices):
        poly.use_smooth = True
        poly.material_index = mat_index
    uv_layer = mesh.uv_layers.new(name="UVMap")
    for poly in mesh.polygons:
        for loop_index in poly.loop_indices:
            uv_layer.data[loop_index].uv = uvs[mesh.loops[loop_index].vertex_index]
    bevel = obj.modifiers.new("soft compressed tire bevel", "BEVEL")
    bevel.width = 0.006 * s
    bevel.segments = 2
    obj.modifiers.new("weighted tire normals", "WEIGHTED_NORMAL")
    return obj


def add_flat_patch(name, x, y, z, angle, sx, sy, sz, mat):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=1, location=(x, y, z))
    obj = bpy.context.object
    obj.name = name
    obj.scale = (sx, sy, sz)
    obj.rotation_euler[2] = angle
    obj.data.materials.append(mat)
    obj.modifiers.new("soft scuff normals", "WEIGHTED_NORMAL")
    return obj


def add_short_arc_mark(prefix, center, angle, radius, z, mat, count):
    for i in range(count):
        a = angle + (i - (count - 1) * 0.5) * 0.055
        x = center[0] + math.cos(a) * radius
        y = center[1] + math.sin(a) * radius
        add_flat_patch(f"{prefix}_arc_scuff_{i:02d}", x, y, z, a + math.pi * 0.5, 0.045, 0.012, 0.006, mat)


def add_one_tire(prefix, x, y, z, paint_mat, dark_mat, dust_mat, highlight_mat, seed, yaw=0.0, scale=1.0):
    rng = random.Random(seed)
    s = scale

    # Custom generated profile: flatter than a torus, closer to a trackside barrier tire.
    add_flat_tire_body(f"{prefix}_compressed_painted_tire_body", x, y, z, paint_mat, highlight_mat, dark_mat, s)

    # Dark inner cavity and narrow outer tread bands match the concept image without becoming realistic tire detail.
    add_cylinder(f"{prefix}_black_inner_cavity", (x, y, z + 0.082 * s), 0.235 * s, 0.026 * s, dark_mat, 72)
    add_torus(f"{prefix}_inner_lip_shadow", (x, y, z + 0.104 * s), 0.270 * s, 0.012 * s, dark_mat, 96, 8)
    add_torus(f"{prefix}_outer_shadow_band", (x, y, z - 0.010 * s), 0.585 * s, 0.010 * s, dark_mat, 96, 8)
    add_torus(f"{prefix}_worn_top_painted_lip", (x, y, z + 0.126 * s), 0.452 * s, 0.008 * s, highlight_mat, 96, 8)

    # Low-relief molded side marks. They read as stylized tire construction instead of spikes.
    for i in range(16):
        if i % 2 and rng.random() < 0.45:
            continue
        a = yaw + (i / 16) * math.tau + rng.uniform(-0.025, 0.025)
        r = 0.585 * s
        add_flat_patch(
            f"{prefix}_subtle_outer_mold_{i:02d}",
            x + math.cos(a) * r,
            y + math.sin(a) * r,
            z + rng.choice([-0.036, 0.032]) * s,
            a,
            0.014 * s,
            0.006 * s,
            0.032 * s,
            dark_mat,
        )

    # Dust/chipped-paint strokes sit on the upper face like the concept's readable arcade grime.
    for i in range(15):
        a = yaw + rng.random() * math.tau
        r = rng.uniform(0.34, 0.57) * s
        mat = dust_mat if rng.random() < 0.72 else dark_mat
        add_flat_patch(
            f"{prefix}_paint_chip_{i:02d}",
            x + math.cos(a) * r,
            y + math.sin(a) * r,
            z + 0.135 * s,
            a + rng.uniform(-0.7, 0.7),
            rng.uniform(0.018, 0.050) * s,
            rng.uniform(0.007, 0.014) * s,
            0.004 * s,
            mat,
        )
    add_short_arc_mark(prefix, (x, y), yaw + rng.random() * math.tau, 0.515 * s, z + 0.138 * s, dust_mat, 4)


def add_tire_wall(mats):
    palette = [mats["red"], mats["cream"], mats["red_deep"], mats["dark"], mats["cream"], mats["red"], mats["red_deep"]]
    xs = [-2.55, -1.68, -0.82, 0.04, 0.90, 1.76, 2.62]
    for row, y in enumerate([0.0, 0.42]):
        for i, x in enumerate(xs):
            if row == 1 and i in (0, 6):
                continue
            paint = palette[(i + row * 2) % len(palette)]
            add_one_tire(
                f"wall_row_{row}_{i}",
                x + (0.43 if row else 0.0),
                y + (0.02 if i % 2 else -0.01),
                0.16 + row * 0.245,
                paint,
                mats["rubber"],
                mats["dust"] if paint != mats["cream"] else mats["mud"],
                mats["red_light"] if paint != mats["cream"] else mats["cream_light"],
                100 + row * 30 + i,
                yaw=0.05 * math.sin(i * 1.7),
                scale=0.78,
            )

    # A few loose foreground tires make the module read like the concept art's near barrier pile.
    for i, (x, y, paint) in enumerate([
        (-3.05, -0.48, mats["cream"]),
        (-2.15, -0.58, mats["red"]),
        (2.18, -0.46, mats["dark"]),
        (3.06, -0.55, mats["cream"]),
    ]):
        add_one_tire(
            f"loose_foreground_{i}",
            x,
            y,
            0.13,
            paint,
            mats["rubber"],
            mats["mud"],
            mats["cream_light"] if paint == mats["cream"] else mats["red_light"],
            240 + i,
            yaw=0.1 * (i - 1.5),
            scale=0.74,
        )


def add_preview_track_slice(mats):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, -1.05, -0.04))
    road = bpy.context.object
    road.name = "preview_asphalt_strip_not_exported"
    road.dimensions = (7.6, 2.35, 0.045)
    road.data.materials.append(mats["asphalt"])

    for i in range(14):
        bpy.ops.mesh.primitive_cube_add(size=1, location=(-3.55 + i * 0.55, -2.25, 0.006))
        curb = bpy.context.object
        curb.name = f"preview_red_white_curb_{i:02d}_not_exported"
        curb.dimensions = (0.42, 0.22, 0.035)
        curb.data.materials.append(mats["red"] if i % 2 == 0 else mats["cream"])

    bpy.ops.mesh.primitive_plane_add(size=8.5, location=(0, 0.35, -0.085))
    ground = bpy.context.object
    ground.name = "preview_grass_floor_not_exported"
    ground.data.materials.append(mats["grass"])


def add_lighting_and_camera():
    bpy.context.scene.world.color = (0.70, 0.86, 1.0)
    bpy.ops.object.light_add(type="AREA", location=(-3.6, -4.4, 5.2))
    key = bpy.context.object
    key.name = "large_soft_sun_key"
    key.data.energy = 820
    key.data.size = 5.0
    bpy.ops.object.light_add(type="AREA", location=(3.8, 2.5, 3.5))
    fill = bpy.context.object
    fill.name = "blue_sky_fill"
    fill.data.energy = 260
    fill.data.size = 6.0
    bpy.ops.object.camera_add(location=(3.25, -4.65, 1.55), rotation=(math.radians(70), 0, math.radians(36)))
    camera = bpy.context.object
    camera.name = "preview_camera"
    camera.data.lens = 55
    bpy.context.scene.camera = camera


def set_render_settings():
    bpy.context.scene.render.engine = "CYCLES"
    bpy.context.scene.cycles.samples = 96
    bpy.context.scene.view_settings.view_transform = "AgX"
    bpy.context.scene.view_settings.look = "AgX - Medium High Contrast"
    bpy.context.scene.view_settings.exposure = 0.65
    bpy.context.scene.render.resolution_x = 1400
    bpy.context.scene.render.resolution_y = 900


def main():
    export_final = "--export-final" in sys.argv
    clean_scene()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    DOCS_DIR.mkdir(parents=True, exist_ok=True)

    mats = {
        "red": make_mat("painted_rubber_red", (0.78, 0.085, 0.045, 1), 0.84),
        "red_deep": make_mat("painted_rubber_deep_red", (0.50, 0.045, 0.035, 1), 0.88),
        "red_light": make_mat("scraped_warm_red_edge", (1.00, 0.23, 0.13, 1), 0.82),
        "cream": make_mat("painted_rubber_warm_white", (0.82, 0.76, 0.64, 1), 0.86),
        "cream_light": make_mat("scraped_chalky_white_edge", (1.00, 0.93, 0.76, 1), 0.84),
        "dark": make_mat("painted_rubber_charcoal", (0.055, 0.055, 0.050, 1), 0.91),
        "rubber": make_mat("deep_black_inner_rubber", (0.006, 0.006, 0.005, 1), 0.96),
        "dust": make_mat("dry_beige_track_dust", (0.66, 0.48, 0.30, 1), 0.93),
        "mud": make_mat("soft_grey_mud_scuffs", (0.34, 0.31, 0.27, 1), 0.94),
        "asphalt": make_mat("preview_soft_asphalt", (0.20, 0.22, 0.22, 1), 0.86),
        "grass": make_mat("preview_bright_grass", (0.36, 0.66, 0.22, 1), 0.88),
    }

    add_preview_track_slice(mats)
    add_tire_wall(mats)
    add_lighting_and_camera()
    set_render_settings()

    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_OUT))
    if export_final:
        for obj in bpy.context.scene.objects:
            obj.select_set(obj.type == "MESH" and "_not_exported" not in obj.name)
        bpy.ops.export_scene.gltf(
            filepath=str(GLB_OUT),
            export_format="GLB",
            use_selection=True,
            export_apply=True,
            export_texcoords=True,
            export_normals=True,
            export_materials="EXPORT",
            export_yup=True,
        )
        print(f"wrote {GLB_OUT}")
    else:
        print("preview only; rerun with --export-final after approval")

    bpy.context.scene.render.filepath = str(PREVIEW_OUT)
    bpy.ops.render.render(write_still=True)
    print(f"wrote {BLEND_OUT}")
    print(f"wrote {PREVIEW_OUT}")


if __name__ == "__main__":
    main()
