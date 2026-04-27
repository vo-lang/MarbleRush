import math
import os
from pathlib import Path

import bpy


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "models" / "scenic" / "tire_wall.glb"


def clean_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()


def color_mix(a, b, t):
    return [a[i] * (1 - t) + b[i] * t for i in range(4)]


def noise(x, y):
    n = (x * 374761393 + y * 668265263) & 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((n ^ (n >> 16)) & 255) / 255.0


def make_image(name, base, hi, low):
    size = 512
    image = bpy.data.images.new(name, width=size, height=size, alpha=True)
    pixels = [0.0] * (size * size * 4)
    for y in range(size):
        v = y / (size - 1)
        molded = 1.0 if abs((v * 8.0) % 1.0 - 0.5) < 0.055 else 0.0
        for x in range(size):
            u = x / (size - 1)
            fine = noise(x, y) - 0.5
            broad = noise(x // 17, y // 17)
            dirt = noise((x + 37) // 11, (y - 19) // 11)
            ring = 0.5 + 0.5 * math.sin(v * math.pi * 18)
            color = color_mix(low, hi, 0.20 + broad * 0.16 + ring * 0.045)
            color = color_mix(color, base, 0.58)
            color = color_mix(color, [0.12, 0.11, 0.095, 1.0], dirt * 0.25)
            if molded:
                color = color_mix(color, hi, 0.045)
            scratch = noise(x * 7 + 13, y * 11 + 29)
            if scratch > 0.986 and abs(((u * 31 + v * 5) % 1.0) - 0.5) < 0.08:
                color = color_mix(color, hi, 0.16)
            color[0] += fine * 0.025
            color[1] += fine * 0.022
            color[2] += fine * 0.020
            idx = (y * size + x) * 4
            pixels[idx:idx + 4] = [max(0, min(1, c)) for c in color]
    image.pixels.foreach_set(pixels)
    image.pack()
    return image


def make_normal_image():
    size = 512
    image = bpy.data.images.new("tire_sidewall_normal", width=size, height=size, alpha=True)
    pixels = [0.0] * (size * size * 4)
    for y in range(size):
        v = y / (size - 1)
        for x in range(size):
            h0 = 0.12 * math.sin(v * math.pi * 26) + (noise(x // 4, y // 4) - 0.5) * 0.18
            h1 = 0.12 * math.sin(((y + 1) / (size - 1)) * math.pi * 26) + (noise((x + 1) // 4, (y + 1) // 4) - 0.5) * 0.18
            dx = (noise((x + 1) // 3, y // 3) - noise((x - 1) // 3, y // 3)) * 0.26
            dy = (h1 - h0) * 1.6
            nz = 1.0
            length = math.sqrt(dx * dx + dy * dy + nz * nz)
            idx = (y * size + x) * 4
            pixels[idx:idx + 4] = [0.5 - dx / length * 0.5, 0.5 - dy / length * 0.5, 0.5 + nz / length * 0.5, 1.0]
    image.pixels.foreach_set(pixels)
    image.pack()
    return image


def make_mat(name, albedo_image, normal_image, roughness=0.88):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = 0.0

    tex = nodes.new("ShaderNodeTexImage")
    tex.image = albedo_image
    mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])

    ntex = nodes.new("ShaderNodeTexImage")
    ntex.image = normal_image
    ntex.image.colorspace_settings.name = "Non-Color"
    nmap = nodes.new("ShaderNodeNormalMap")
    nmap.inputs["Strength"].default_value = 0.72
    mat.node_tree.links.new(ntex.outputs["Color"], nmap.inputs["Color"])
    mat.node_tree.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


def make_plain_mat(name, color, roughness=0.95):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = 0.0
    return mat


def create_tire_mesh(name, outer_radius, inner_radius, height, material, inner_material, x, y, z):
    seg = 96
    profile = [
        (inner_radius * 1.00, height * 0.36),
        (inner_radius * 1.10, height * 0.48),
        (inner_radius * 1.45, height * 0.50),
        (outer_radius * 0.83, height * 0.46),
        (outer_radius * 0.96, height * 0.33),
        (outer_radius * 1.00, height * 0.12),
        (outer_radius * 1.00, -height * 0.12),
        (outer_radius * 0.96, -height * 0.33),
        (outer_radius * 0.83, -height * 0.46),
        (inner_radius * 1.45, -height * 0.50),
        (inner_radius * 1.10, -height * 0.48),
        (inner_radius * 1.00, -height * 0.36),
    ]
    verts = []
    uvs = []
    faces = []
    face_materials = []
    for i in range(seg):
        a = (i / seg) * math.tau
        ca = math.cos(a)
        sa = math.sin(a)
        for j, (radius, py) in enumerate(profile):
            verts.append((x + ca * radius, z + sa * radius, y + py))
            uvs.append((i / seg, j / (len(profile) - 1)))
    count = len(profile)
    for i in range(seg):
        ni = (i + 1) % seg
        for j in range(count - 1):
            faces.append((i * count + j, ni * count + j, ni * count + j + 1, i * count + j + 1))
            face_materials.append(0)
        faces.append((i * count + count - 1, ni * count + count - 1, ni * count, i * count))
        face_materials.append(1)

    mesh = bpy.data.meshes.new(name + "Mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(material)
    obj.data.materials.append(inner_material)
    for poly, material_index in zip(mesh.polygons, face_materials):
        poly.use_smooth = True
        poly.material_index = material_index

    uv_layer = mesh.uv_layers.new(name="UVMap")
    for poly in mesh.polygons:
        for loop_index in poly.loop_indices:
            uv_layer.data[loop_index].uv = uvs[mesh.loops[loop_index].vertex_index]

    bevel = obj.modifiers.new("soft rubber bevels", "BEVEL")
    bevel.width = 0.012
    bevel.segments = 2
    bevel.affect = "EDGES"
    obj.modifiers.new("weighted rubber normals", "WEIGHTED_NORMAL")
    return obj


def add_ring(name, radius, y, material, x, z, minor=0.008):
    bpy.ops.mesh.primitive_torus_add(major_radius=radius, minor_radius=minor, major_segments=96, minor_segments=6, location=(x, z, y))
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(material)
    return obj


def add_tread_blocks(prefix, x, y, z, outer_radius, height, material):
    for i in range(48):
        a = (i / 48) * math.tau
        ca = math.cos(a)
        sa = math.sin(a)
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x + ca * (outer_radius + 0.006), z + sa * (outer_radius + 0.006), y))
        obj = bpy.context.object
        obj.name = f"{prefix}_tread_{i:02d}"
        obj.dimensions = (0.055, 0.018, height * 0.62)
        obj.rotation_euler[2] = a
        obj.data.materials.append(material)
        bevel = obj.modifiers.new("worn groove edge", "BEVEL")
        bevel.width = 0.004
        bevel.segments = 1
        obj.modifiers.new("weighted normals", "WEIGHTED_NORMAL")


def add_tire(prefix, mat, dark_mat, x, y, z):
    outer = 0.58
    inner = 0.295
    height = 0.265
    create_tire_mesh(prefix, outer, inner, height, mat, dark_mat, x, y + height * 0.5, z)
    add_tread_blocks(prefix, x, y + height * 0.5, z, outer, height, dark_mat)
    for radius, lift, minor in [
        (inner * 1.12, height * 0.93, 0.009),
        (inner * 1.42, height * 0.98, 0.006),
        (outer * 0.78, height * 0.96, 0.006),
        (outer * 0.91, height * 0.90, 0.007),
    ]:
        add_ring(f"{prefix}_raised_ring_{radius:.2f}", radius, y + lift, mat, x, z, minor)
    add_ring(prefix + "_inner_shadow", inner * 0.92, y + height * 0.52, dark_mat, x, z, 0.018)


def add_stack(prefix, x, z, mats):
    for layer, mat in enumerate(mats):
        add_tire(f"{prefix}_{layer}", mat, bpy.data.materials["deep_inner_rubber"], x, layer * 0.245, z)


def main():
    clean_scene()
    OUT.parent.mkdir(parents=True, exist_ok=True)

    normal = make_normal_image()
    red = make_mat("aged_red_rubber", make_image("aged_red_rubber_albedo", [0.52, 0.13, 0.09, 1], [0.78, 0.26, 0.17, 1], [0.20, 0.05, 0.04, 1]), normal, 0.9)
    cream = make_mat("aged_cream_rubber", make_image("aged_cream_rubber_albedo", [0.66, 0.60, 0.48, 1], [0.90, 0.84, 0.68, 1], [0.30, 0.27, 0.20, 1]), normal, 0.91)
    grey = make_mat("aged_grey_rubber", make_image("aged_grey_rubber_albedo", [0.28, 0.26, 0.23, 1], [0.50, 0.47, 0.40, 1], [0.08, 0.075, 0.065, 1]), normal, 0.92)
    dark = make_mat("aged_black_rubber", make_image("aged_black_rubber_albedo", [0.09, 0.085, 0.075, 1], [0.24, 0.22, 0.19, 1], [0.015, 0.014, 0.013, 1]), normal, 0.94)
    make_plain_mat("deep_inner_rubber", [0.002, 0.002, 0.002, 1.0], 0.98)

    add_stack("left_red", -2.35, 0, [dark, red])
    add_stack("cream_stack", -1.18, 0.03, [grey, cream, cream])
    add_stack("center_red", 0.02, 0, [grey, red])
    add_stack("dark_stack", 1.20, 0.03, [dark, grey])
    add_stack("right_red", 2.36, 0, [grey, red])

    for obj in bpy.context.scene.objects:
        obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    bpy.ops.export_scene.gltf(
        filepath=str(OUT),
        export_format="GLB",
        use_selection=False,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_yup=True,
    )
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
