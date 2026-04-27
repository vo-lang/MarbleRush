import math
import sys
from pathlib import Path

import bpy


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "assets" / "models" / "scenic"
DOCS_DIR = ROOT / "docs" / "images"
BLEND_OUT = OUT_DIR / "concept_tire.blend"
GLB_OUT = OUT_DIR / "concept_tire.glb"
PREVIEW_OUT = DOCS_DIR / "concept-tire-preview.png"


def clean_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()


def clamp(v, lo=0.0, hi=1.0):
    return max(lo, min(hi, v))


def mix(a, b, t):
    return [a[i] * (1.0 - t) + b[i] * t for i in range(4)]


def noise(x, y):
    n = (x * 374761393 + y * 668265263) & 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((n ^ (n >> 16)) & 255) / 255.0


def make_image(name, size, sampler, colorspace="sRGB"):
    image = bpy.data.images.new(name, width=size, height=size, alpha=True)
    pixels = [0.0] * (size * size * 4)
    for y in range(size):
        for x in range(size):
            c = sampler(x, y, size)
            idx = (y * size + x) * 4
            pixels[idx:idx + 4] = [clamp(v) for v in c]
    image.pixels.foreach_set(pixels)
    image.colorspace_settings.name = colorspace
    image.pack()
    return image


def painted_red_albedo(x, y, size):
    u = x / (size - 1)
    v = y / (size - 1)
    fine = noise(x, y) - 0.5
    broad = noise(x // 19, y // 19)
    rubber_show = noise((x + 31) // 7, (y - 17) // 7)
    side_ring = 0.5 + 0.5 * math.sin(v * math.pi * 20.0)
    molded_band = 1.0 if abs((v * 7.5) % 1.0 - 0.5) < 0.055 else 0.0
    color = mix([0.54, 0.07, 0.045, 1], [1.0, 0.24, 0.13, 1], 0.52 + broad * 0.22 + side_ring * 0.07)
    color = mix(color, [0.09, 0.075, 0.055, 1], max(0, rubber_show - 0.80) * 1.35)
    color = mix(color, [1.0, 0.82, 0.62, 1], molded_band * 0.07)
    if noise(x * 5 + 13, y * 11 + 9) > 0.986 and abs(((u * 25.0 + v * 6.0) % 1.0) - 0.5) < 0.09:
        color = mix(color, [0.98, 0.62, 0.48, 1], 0.32)
    dirt = noise((x - 23) // 13, (y + 41) // 13)
    color = mix(color, [0.13, 0.10, 0.075, 1], dirt * 0.18)
    color[0] += fine * 0.035
    color[1] += fine * 0.025
    color[2] += fine * 0.020
    return color


def dark_rubber_albedo(x, y, size):
    v = y / (size - 1)
    groove = 0.5 + 0.5 * math.sin(v * math.pi * 42.0)
    fine = noise(x, y) - 0.5
    color = mix([0.028, 0.027, 0.025, 1], [0.20, 0.19, 0.16, 1], groove * 0.34 + noise(x // 11, y // 11) * 0.20)
    if noise(x * 7 + 5, y * 3 + 19) > 0.986:
        color = mix(color, [0.42, 0.39, 0.32, 1], 0.22)
    color[0] += fine * 0.025
    color[1] += fine * 0.025
    color[2] += fine * 0.022
    return color


def tire_normal(x, y, size):
    v = y / (size - 1)
    h0 = math.sin(v * math.pi * 26.0) * 0.18 + noise(x // 4, y // 4) * 0.18
    h1 = math.sin(((y + 1) / (size - 1)) * math.pi * 26.0) * 0.18 + noise((x + 1) // 4, (y + 1) // 4) * 0.18
    dx = (noise((x + 1) // 3, y // 3) - noise((x - 1) // 3, y // 3)) * 0.36
    dy = (h1 - h0) * 1.7
    nz = 1.0
    length = math.sqrt(dx * dx + dy * dy + nz * nz)
    return [0.5 - dx / length * 0.5, 0.5 - dy / length * 0.5, 0.5 + nz / length * 0.5, 1.0]


def make_mat(name, image, normal, roughness):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (1, 1, 1, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = 0.0
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = image
    mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    ntex = nodes.new("ShaderNodeTexImage")
    ntex.image = normal
    ntex.image.colorspace_settings.name = "Non-Color"
    nmap = nodes.new("ShaderNodeNormalMap")
    nmap.inputs["Strength"].default_value = 0.82
    mat.node_tree.links.new(ntex.outputs["Color"], nmap.inputs["Color"])
    mat.node_tree.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


def plain_mat(name, color, roughness=0.9):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = 0
    return mat


def make_surface_mat(name, color, roughness=0.86):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = 0
    return mat


def create_tire_body(red_mat, outer_mat, inner_mat):
    seg = 192
    profile = [
        (0.38, 0.28),
        (0.43, 0.37),
        (0.58, 0.44),
        (0.78, 0.43),
        (0.96, 0.31),
        (1.04, 0.14),
        (1.05, 0.00),
        (1.04, -0.14),
        (0.96, -0.31),
        (0.78, -0.43),
        (0.58, -0.44),
        (0.43, -0.37),
        (0.38, -0.28),
    ]
    verts = []
    uvs = []
    faces = []
    mats = []
    for i in range(seg):
        a = (i / seg) * math.tau
        ca = math.cos(a)
        sa = math.sin(a)
        for j, (r, y) in enumerate(profile):
            wobble = 1.0 + 0.006 * math.sin(a * 9.0 + j * 0.7) + 0.004 * math.sin(a * 23.0)
            verts.append((ca * r * wobble, sa * r * wobble, y))
            uvs.append((i / seg, j / (len(profile) - 1)))
    count = len(profile)
    for i in range(seg):
        ni = (i + 1) % seg
        for j in range(count - 1):
            faces.append((i * count + j, ni * count + j, ni * count + j + 1, i * count + j + 1))
            mats.append(1 if j in (5, 6) else 0)
        faces.append((i * count + count - 1, ni * count + count - 1, ni * count, i * count))
        mats.append(2)
    mesh = bpy.data.meshes.new("ConceptTireBodyMesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new("concept_tire_body_red_worn_sidewall", mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(red_mat)
    obj.data.materials.append(outer_mat)
    obj.data.materials.append(inner_mat)
    for poly, mat_index in zip(mesh.polygons, mats):
        poly.use_smooth = True
        poly.material_index = mat_index
    uv_layer = mesh.uv_layers.new(name="UVMap")
    for poly in mesh.polygons:
        for loop_index in poly.loop_indices:
            uv_layer.data[loop_index].uv = uvs[mesh.loops[loop_index].vertex_index]
    bevel = obj.modifiers.new("soft rounded inflated tire edges", "BEVEL")
    bevel.width = 0.018
    bevel.segments = 3
    obj.modifiers.new("weighted tire normals", "WEIGHTED_NORMAL")
    return obj


def add_molded_sidewall_detail(red_mat, outer_mat, inner_mat):
    for z, mat, radius, minor in [
        (0.355, red_mat, 0.70, 0.010),
        (-0.355, red_mat, 0.70, 0.010),
        (0.405, outer_mat, 0.48, 0.010),
        (-0.405, outer_mat, 0.48, 0.010),
        (0.0, inner_mat, 0.385, 0.018),
    ]:
        bpy.ops.mesh.primitive_torus_add(major_radius=radius, minor_radius=minor, major_segments=160, minor_segments=8, location=(0, 0, z))
        obj = bpy.context.object
        obj.name = f"molded_sidewall_ring_{z:.2f}"
        obj.data.materials.append(mat)

    for i in range(22):
        angle = (i / 22) * math.tau
        radius = 0.78 + 0.025 * math.sin(i * 1.9)
        z = 0.372 if i % 2 == 0 else -0.372
        bpy.ops.mesh.primitive_cube_add(size=1, location=(math.cos(angle) * radius, math.sin(angle) * radius, z))
        obj = bpy.context.object
        obj.name = f"subtle_molded_sidewall_mark_{i:02d}"
        obj.dimensions = (0.13 + 0.03 * (i % 3), 0.010, 0.025)
        obj.rotation_euler = (0, 0, angle + math.pi * 0.5)
        obj.data.materials.append(red_mat if i % 3 else outer_mat)
        bevel = obj.modifiers.new("soft molded mark bevel", "BEVEL")
        bevel.width = 0.003
        bevel.segments = 1


def add_paint_chips(dust_mat, dark_mat, highlight_mat):
    for i in range(24):
        angle = (i / 34) * math.tau + 0.04 * math.sin(i * 2.3)
        radius = 0.58 + 0.34 * ((i * 37) % 100) / 100
        z = 0.438 if i % 3 != 0 else -0.438
        mat = dust_mat if i % 4 else dark_mat
        bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=1, location=(math.cos(angle) * radius, math.sin(angle) * radius, z))
        obj = bpy.context.object
        obj.name = f"flat_dust_and_chipped_paint_patch_{i:02d}"
        obj.scale = (0.045 + 0.025 * (i % 3), 0.010, 0.006)
        obj.rotation_euler = (0, 0, angle + 0.7 * math.sin(i))
        obj.data.materials.append(mat)
        obj.modifiers.new("soft patch normals", "WEIGHTED_NORMAL")

    for i in range(14):
        angle = (i / 18) * math.tau + 0.09
        bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=6, radius=1, location=(math.cos(angle) * 1.048, math.sin(angle) * 1.048, -0.06 + (i % 3) * 0.055))
        obj = bpy.context.object
        obj.name = f"outer_edge_worn_red_highlight_{i:02d}"
        obj.scale = (0.020, 0.010, 0.055)
        obj.rotation_euler = (0, 0, angle)
        obj.data.materials.append(highlight_mat)


def add_preview_floor():
    mat = make_surface_mat("matte_warm_preview_floor", (0.62, 0.68, 0.58, 1), 0.9)
    bpy.ops.mesh.primitive_plane_add(size=5.2, location=(0, 0, -0.55))
    floor = bpy.context.object
    floor.name = "preview_floor_not_part_of_asset"
    floor.data.materials.append(mat)


def add_scene_lighting():
    bpy.ops.object.light_add(type="AREA", location=(-3.8, -4.8, 6.2))
    key = bpy.context.object
    key.name = "large soft concept-art key light"
    key.data.energy = 1150
    key.data.size = 4.6
    bpy.ops.object.light_add(type="AREA", location=(3.2, 2.9, 4.0))
    fill = bpy.context.object
    fill.name = "soft blue sky fill"
    fill.data.energy = 420
    fill.data.size = 5.5
    bpy.ops.object.light_add(type="POINT", location=(-1.6, 2.2, 2.0))
    rim = bpy.context.object
    rim.name = "small warm rim highlight"
    rim.data.energy = 180
    bpy.context.scene.world.color = (0.82, 0.9, 1.0)


def add_camera():
    bpy.ops.object.camera_add(location=(2.45, -3.75, 1.45), rotation=(math.radians(70), 0, math.radians(34)))
    camera = bpy.context.object
    camera.data.lens = 52
    camera.data.dof.use_dof = True
    camera.data.dof.focus_distance = 4.5
    camera.data.dof.aperture_fstop = 6.5
    bpy.context.scene.camera = camera


def main():
    export_final = "--export-final" in sys.argv
    clean_scene()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    normal = make_image("worn_tire_normal_packed", 768, tire_normal, "Non-Color")
    red = make_mat("sun_faded_red_painted_rubber", make_image("red_painted_rubber_albedo", 768, painted_red_albedo), normal, 0.82)
    outer = make_surface_mat("dark_worn_outer_tread_band", (0.22, 0.035, 0.026, 1), 0.88)
    inner = plain_mat("deep_black_inner_hollow", (0.003, 0.0025, 0.002, 1), 0.98)
    dust = make_surface_mat("warm_dust_scuffed_paint", (0.78, 0.63, 0.42, 1), 0.9)
    chip_dark = make_surface_mat("exposed_dirty_black_rubber_chips", (0.055, 0.045, 0.036, 1), 0.94)
    highlight = make_surface_mat("fresh_scraped_red_edge", (1.0, 0.26, 0.14, 1), 0.82)
    create_tire_body(red, outer, inner)
    add_molded_sidewall_detail(red, outer, inner)
    add_paint_chips(dust, chip_dark, highlight)
    add_preview_floor()
    add_scene_lighting()
    add_camera()
    bpy.context.scene.render.engine = "CYCLES"
    bpy.context.scene.cycles.samples = 128
    bpy.context.scene.view_settings.view_transform = "AgX"
    bpy.context.scene.view_settings.look = "AgX - Medium High Contrast"
    bpy.context.scene.view_settings.exposure = 1.15
    bpy.context.scene.view_settings.gamma = 1.0
    bpy.context.scene.render.resolution_x = 1200
    bpy.context.scene.render.resolution_y = 900
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_OUT))
    if export_final:
        for obj in bpy.context.scene.objects:
            obj.select_set(obj.name != "preview_floor_not_part_of_asset" and obj.type == "MESH")
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
    bpy.context.scene.render.filepath = str(PREVIEW_OUT)
    bpy.ops.render.render(write_still=True)
    print(f"wrote {BLEND_OUT}")
    if export_final:
        print(f"wrote {GLB_OUT}")
    else:
        print("preview only; rerun with --export-final after approval")
    print(f"wrote {PREVIEW_OUT}")


if __name__ == "__main__":
    main()
