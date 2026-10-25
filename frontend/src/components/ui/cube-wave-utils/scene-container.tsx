import * as React from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { ThemeMode } from "./use-shadcn-theme";

export type SceneContainerProps = {
  children?: React.ReactNode;
  className?: string;
  theme?: ThemeMode;
  environment?:
    | "studio"
    | "city"
    | "dawn"
    | "night"
    | "sunset"
    | "apartment"
    | "forest"
    | "lobby"
    | "park"
    | "warehouse"
    | string;
  camera?: [number, number, number];
  fov?: number;
  interactiveParallax?: boolean;
};

function CameraRig({ defaultPos }: { defaultPos: [number, number, number] }) {
  useFrame((state) => {
    state.camera.position.x = THREE.MathUtils.lerp(
      state.camera.position.x,
      defaultPos[0] + state.pointer.x * 1.8,
      0.04
    );
    state.camera.position.y = THREE.MathUtils.lerp(
      state.camera.position.y,
      defaultPos[1] + state.pointer.y * 1.2,
      0.04
    );
    state.camera.lookAt(0, 0, 0);
  });
  return null;
}

export function SceneContainer({
  children,
  className,
  camera = [8, 7, 8],
  fov = 32,
  interactiveParallax = true,
}: SceneContainerProps) {
  return (
    <div
      className={className}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
      }}
    >
      <Canvas
        camera={{ position: camera, fov }}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        style={{ width: "100%", height: "100%" }}
      >
        <ambientLight intensity={1.2} />
        <directionalLight position={[12, 16, 12]} intensity={2.2} />
        <directionalLight position={[-10, 8, -10]} intensity={0.9} color="#5b8cff" />
        <pointLight position={[0, 6, 0]} intensity={1.8} color="#7c5cff" />
        {interactiveParallax && <CameraRig defaultPos={camera} />}
        {children}
      </Canvas>
    </div>
  );
}

export default SceneContainer;
