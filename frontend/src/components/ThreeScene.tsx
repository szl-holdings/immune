import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { AuthoritativeTripwireState } from "@/lib/immune-api";
import { authorityVisualState } from "@/lib/authority-view";
import { startAnimationLoop } from "@/lib/animation-loop";

export function ThreeScene({ authority }: { authority: AuthoritativeTripwireState }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [webglError, setWebglError] = useState<string | null>(null);
  const visualState = authorityVisualState(authority);

  useEffect(() => {
    if (!mountRef.current) return;

    // Scene setup
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x080b12, 0.04);

    const camera = new THREE.PerspectiveCamera(45, mountRef.current.clientWidth / mountRef.current.clientHeight, 0.1, 1000);
    camera.position.set(0, 8, 25);
    camera.lookAt(0, 0, 0);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    } catch (err) {
      setWebglError((err as Error).message || "WebGL unavailable");
      return;
    }
    renderer.setSize(mountRef.current.clientWidth, mountRef.current.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // renderer.toneMappingExposure = 1.2;
    mountRef.current.appendChild(renderer.domElement);

    // Lights
    const ambientLight = new THREE.AmbientLight(0xe9eef6, 0.2);
    scene.add(ambientLight);

    const pointLight = new THREE.PointLight(0x5cc4bf, 5, 20);
    pointLight.position.set(-6, 2, 5);
    scene.add(pointLight);

    const pointLight2 = new THREE.PointLight(0xd7b96b, 5, 20);
    pointLight2.position.set(6, 2, 5);
    scene.add(pointLight2);
    
    // HEART (Ingress)
    const heartGroup = new THREE.Group();
    heartGroup.position.set(-8, 0, 0);
    scene.add(heartGroup);

    const heartGeo = new THREE.IcosahedronGeometry(1.5, 1);
    const heartMat = new THREE.MeshStandardMaterial({ 
      color: 0x5cc4bf,
      wireframe: true,
      transparent: true,
      opacity: 0.8,
      emissive: 0x5cc4bf,
      emissiveIntensity: 0.5
    });
    const heart = new THREE.Mesh(heartGeo, heartMat);
    heartGroup.add(heart);

    const heartCoreGeo = new THREE.IcosahedronGeometry(0.8, 0);
    const heartCoreMat = new THREE.MeshBasicMaterial({ color: 0x5cc4bf });
    const heartCore = new THREE.Mesh(heartCoreGeo, heartCoreMat);
    heartGroup.add(heartCore);
    
    // SENTRA (Gate)
    const sentraGroup = new THREE.Group();
    sentraGroup.position.set(0, 0, 0);
    scene.add(sentraGroup);

    const sentraRingGeo = new THREE.TorusGeometry(2.5, 0.05, 16, 64);
    const sentraRingMat = new THREE.MeshStandardMaterial({ 
      color: 0x9aa7bd,
      emissive: 0x9aa7bd,
      emissiveIntensity: 0.5,
      transparent: true,
      opacity: 0.6
    });
    const sentraRing1 = new THREE.Mesh(sentraRingGeo, sentraRingMat);
    const sentraRing2 = new THREE.Mesh(sentraRingGeo, sentraRingMat);
    sentraRing1.rotation.x = Math.PI / 2;
    sentraRing2.rotation.y = Math.PI / 2;
    sentraGroup.add(sentraRing1);
    sentraGroup.add(sentraRing2);

    const sentraCoreGeo = new THREE.OctahedronGeometry(1, 0);
    const sentraCoreMat = new THREE.MeshStandardMaterial({ 
      color: 0xe9eef6,
      roughness: 0.1,
      metalness: 0.8,
      emissive: 0x5c6b86,
      emissiveIntensity: 0.2
    });
    const sentraCore = new THREE.Mesh(sentraCoreGeo, sentraCoreMat);
    sentraGroup.add(sentraCore);
    
    // YAWAR (Vault)
    const yawarGroup = new THREE.Group();
    yawarGroup.position.set(8, -3, 0);
    scene.add(yawarGroup);
    
    const slabs: THREE.Mesh[] = [];
    const addSlab = () => {
      const slabGeo = new THREE.BoxGeometry(2.5, 0.15, 2.5);
      const slabMat = new THREE.MeshStandardMaterial({ 
        color: 0xd7b96b,
        transparent: true, 
        opacity: 0.9,
        emissive: 0xd7b96b,
        emissiveIntensity: 0.3,
        roughness: 0.2,
        metalness: 0.8
      });
      const slab = new THREE.Mesh(slabGeo, slabMat);
      slab.position.y = slabs.length * 0.4;
      yawarGroup.add(slab);
      slabs.push(slab);
      if (slabs.length > 25) {
        const old = slabs.shift();
        if (old) yawarGroup.remove(old);
        yawarGroup.position.y -= 0.4;
      }
    };
    
    for(let i=0; i<10; i++) addSlab();
    
    // HUKLLA (Tripwires)
    const hukllaGroup = new THREE.Group();
    hukllaGroup.position.set(0, 0, 0);
    scene.add(hukllaGroup);
    
    const nodes: THREE.Mesh[] = [];
    const orbitRadius = 6;
    for(let i=0; i<10; i++) {
      const angle = (i / 10) * Math.PI * 2;
      const nodeGeo = new THREE.SphereGeometry(0.15, 16, 16);
      const nodeMat = new THREE.MeshBasicMaterial({ color: 0x5cc4bf });
      const node = new THREE.Mesh(nodeGeo, nodeMat);
      node.position.set(Math.cos(angle) * orbitRadius, Math.sin(angle) * 4, Math.sin(angle) * orbitRadius);
      hukllaGroup.add(node);
      nodes.push(node);
    }
    
    // Connections
    const materialLine = new THREE.LineBasicMaterial({ color: 0x5cc4bf, transparent: true, opacity: 0.2 });
    const points1 = [heartGroup.position, sentraGroup.position];
    const geoLine1 = new THREE.BufferGeometry().setFromPoints(points1);
    const line1 = new THREE.Line(geoLine1, materialLine);
    scene.add(line1);

    const materialLine2 = new THREE.LineBasicMaterial({ color: 0xd7b96b, transparent: true, opacity: 0.2 });
    const points2 = [sentraGroup.position, yawarGroup.position.clone().setY(0)];
    const geoLine2 = new THREE.BufferGeometry().setFromPoints(points2);
    const line2 = new THREE.Line(geoLine2, materialLine2);
    scene.add(line2);
    
    let time = 0;
    
    const isDeadman = visualState === "VERIFIED_DEADMAN";
    const isReject =
      visualState === "VERIFIED_REJECT" ||
      visualState === "FAILED" ||
      visualState === "UNAVAILABLE" ||
      visualState === "STALE";
    let pulseSpeed = 1;
    let targetIntensity = 1;
    
    const handleResize = () => {
      if (!mountRef.current) return;
      camera.aspect = mountRef.current.clientWidth / mountRef.current.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mountRef.current.clientWidth, mountRef.current.clientHeight);
    };
    window.addEventListener('resize', handleResize);
    
    const renderFrame = () => {
      time += 0.01 * pulseSpeed;
      
      if (isDeadman) {
        // DEADMAN: Red alert, frozen motion
        pulseSpeed = THREE.MathUtils.lerp(pulseSpeed, 0.1, 0.05);
        targetIntensity = 2 + Math.sin(time * 20) * 1.5;
        
        scene.fog!.color.lerp(new THREE.Color(0x220000), 0.05);
        
        heartMat.color.lerp(new THREE.Color(0x330000), 0.05);
        heartMat.emissive.lerp(new THREE.Color(0x330000), 0.05);
        heartCoreMat.color.lerp(new THREE.Color(0xdf735f), 0.05);
        
        sentraCoreMat.emissive.lerp(new THREE.Color(0xdf735f), 0.1);
        sentraRingMat.color.lerp(new THREE.Color(0xdf735f), 0.1);
        sentraRingMat.emissive.lerp(new THREE.Color(0xdf735f), 0.1);
        
        pointLight.color.lerp(new THREE.Color(0xdf735f), 0.1);
        pointLight2.color.lerp(new THREE.Color(0xdf735f), 0.1);
        pointLight.intensity = targetIntensity;
        pointLight2.intensity = targetIntensity;

        nodes.forEach(n => (n.material as THREE.MeshBasicMaterial).color.lerp(new THREE.Color(0xdf735f), 0.1));
        
      } else if (isReject) {
        // REJECT: Orange/Warning, sharp pulsing
        pulseSpeed = THREE.MathUtils.lerp(pulseSpeed, 2.5, 0.05);
        targetIntensity = 1 + Math.sin(time * 10) * 0.5;

        scene.fog!.color.lerp(new THREE.Color(0x1a0a00), 0.05);

        heartMat.color.lerp(new THREE.Color(0xe4cf99), 0.05);
        heartMat.emissive.lerp(new THREE.Color(0xe4cf99), 0.05);
        heartCoreMat.color.lerp(new THREE.Color(0xd7b96b), 0.05);

        sentraCoreMat.emissive.lerp(new THREE.Color(0xe4cf99), 0.1);
        sentraRingMat.color.lerp(new THREE.Color(0xd7b96b), 0.1);
        sentraRingMat.emissive.lerp(new THREE.Color(0xd7b96b), 0.1);

        pointLight.color.lerp(new THREE.Color(0xd7b96b), 0.1);
        pointLight2.color.lerp(new THREE.Color(0xd7b96b), 0.1);
        
        nodes.forEach(n => (n.material as THREE.MeshBasicMaterial).color.lerp(new THREE.Color(0xe4cf99), 0.1));

      } else {
        // PASS: Cyan/Blue, smooth flowing
        pulseSpeed = THREE.MathUtils.lerp(pulseSpeed, 1, 0.05);
        targetIntensity = 1;

        scene.fog!.color.lerp(new THREE.Color(0x080b12), 0.05);

        heartMat.color.lerp(new THREE.Color(0x5cc4bf), 0.05);
        heartMat.emissive.lerp(new THREE.Color(0x5cc4bf), 0.05);
        heartCoreMat.color.lerp(new THREE.Color(0x5cc4bf), 0.05);

        sentraCoreMat.emissive.lerp(new THREE.Color(0x5c6b86), 0.1);
        sentraRingMat.color.lerp(new THREE.Color(0x9aa7bd), 0.1);
        sentraRingMat.emissive.lerp(new THREE.Color(0x9aa7bd), 0.1);

        pointLight.color.lerp(new THREE.Color(0x5cc4bf), 0.1);
        pointLight2.color.lerp(new THREE.Color(0xd7b96b), 0.1);
        pointLight.intensity = THREE.MathUtils.lerp(pointLight.intensity, targetIntensity, 0.1);
        pointLight2.intensity = THREE.MathUtils.lerp(pointLight2.intensity, targetIntensity, 0.1);
        
        nodes.forEach(n => (n.material as THREE.MeshBasicMaterial).color.lerp(new THREE.Color(0x5cc4bf), 0.1));
      }
      
      // Rotations
      if (!isDeadman) {
        heart.rotation.x += 0.005 * pulseSpeed;
        heart.rotation.y += 0.01 * pulseSpeed;
        
        sentraRing1.rotation.y += 0.02 * pulseSpeed;
        sentraRing2.rotation.x += 0.02 * pulseSpeed;
        sentraCore.rotation.y -= 0.01 * pulseSpeed;
        
        hukllaGroup.rotation.y += 0.005 * pulseSpeed;
        
        heartGroup.position.y = Math.sin(time * 2) * 0.5;
        sentraGroup.position.y = Math.sin(time * 2 + 1) * 0.3;
      }
      
      renderer.render(scene, camera);
    };

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let stopAnimation: (() => void) | null = null;
    const syncAnimation = () => {
      stopAnimation?.();
      stopAnimation = null;
      renderFrame();
      if (!reducedMotion.matches && !document.hidden) stopAnimation = startAnimationLoop(renderFrame);
    };
    reducedMotion.addEventListener("change", syncAnimation);
    document.addEventListener("visibilitychange", syncAnimation);
    syncAnimation();

    return () => {
      window.removeEventListener('resize', handleResize);
      reducedMotion.removeEventListener("change", syncAnimation);
      document.removeEventListener("visibilitychange", syncAnimation);
      stopAnimation?.();
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
          geometries.add(object.geometry);
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
        }
      });
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      renderer.dispose();
      if (mountRef.current && renderer.domElement.parentNode === mountRef.current) {
        mountRef.current.removeChild(renderer.domElement);
      }
    };
  }, [visualState]);

  if (webglError) {
    const deadman = visualState === "VERIFIED_DEADMAN";
    const unavailable = authority.evidenceState !== "VERIFIED";
    return (
      <div className="immune-scene-fallback">
        <div className="immune-flow-map" aria-label="Intent, admission and receipt sequence">
          <span>HEART<small>Intent</small></span><span>SENTRA<small>Admission</small></span><span>YAWAR<small>Receipt</small></span>
        </div>
        {deadman && <p className="text-destructive">DEADMAN ENGAGED · pipeline frozen</p>}
        {unavailable && <p className="text-warning">Authority {authority.evidenceState} · no green control claim</p>}
        <p>Static authority view · WebGL unavailable</p>
      </div>
    );
  }

  return (
    <div
      ref={mountRef}
      className="w-full h-full"
      data-authority-state={visualState}
      aria-label={`Immune authority visualization: ${visualState}`}
    />
  );
}
