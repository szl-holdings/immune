import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { ImmuneCycleResult } from "@workspace/api-client-react";

export function ThreeScene({ lastCycleResult }: { lastCycleResult: ImmuneCycleResult | null }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [webglError, setWebglError] = useState<string | null>(null);

  useEffect(() => {
    if (!mountRef.current) return;

    // Scene setup
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x020202, 0.04);

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
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.2);
    scene.add(ambientLight);

    const pointLight = new THREE.PointLight(0x00ffff, 5, 20);
    pointLight.position.set(-6, 2, 5);
    scene.add(pointLight);

    const pointLight2 = new THREE.PointLight(0xffaa00, 5, 20);
    pointLight2.position.set(6, 2, 5);
    scene.add(pointLight2);
    
    // HEART (Ingress)
    const heartGroup = new THREE.Group();
    heartGroup.position.set(-8, 0, 0);
    scene.add(heartGroup);

    const heartGeo = new THREE.IcosahedronGeometry(1.5, 1);
    const heartMat = new THREE.MeshStandardMaterial({ 
      color: 0x00ffff, 
      wireframe: true,
      transparent: true,
      opacity: 0.8,
      emissive: 0x00ffff,
      emissiveIntensity: 0.5
    });
    const heart = new THREE.Mesh(heartGeo, heartMat);
    heartGroup.add(heart);

    const heartCoreGeo = new THREE.IcosahedronGeometry(0.8, 0);
    const heartCoreMat = new THREE.MeshBasicMaterial({ color: 0x00ffff });
    const heartCore = new THREE.Mesh(heartCoreGeo, heartCoreMat);
    heartGroup.add(heartCore);
    
    // SENTRA (Gate)
    const sentraGroup = new THREE.Group();
    sentraGroup.position.set(0, 0, 0);
    scene.add(sentraGroup);

    const sentraRingGeo = new THREE.TorusGeometry(2.5, 0.05, 16, 64);
    const sentraRingMat = new THREE.MeshStandardMaterial({ 
      color: 0x0088ff,
      emissive: 0x0088ff,
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
      color: 0xffffff,
      roughness: 0.1,
      metalness: 0.8,
      emissive: 0x2244aa,
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
        color: 0xffaa00, 
        transparent: true, 
        opacity: 0.9,
        emissive: 0xffaa00,
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
      const nodeMat = new THREE.MeshBasicMaterial({ color: 0x00ffff });
      const node = new THREE.Mesh(nodeGeo, nodeMat);
      node.position.set(Math.cos(angle) * orbitRadius, Math.sin(angle) * 4, Math.sin(angle) * orbitRadius);
      hukllaGroup.add(node);
      nodes.push(node);
    }
    
    // Connections
    const materialLine = new THREE.LineBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.2 });
    const points1 = [heartGroup.position, sentraGroup.position];
    const geoLine1 = new THREE.BufferGeometry().setFromPoints(points1);
    const line1 = new THREE.Line(geoLine1, materialLine);
    scene.add(line1);

    const materialLine2 = new THREE.LineBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0.2 });
    const points2 = [sentraGroup.position, yawarGroup.position.clone().setY(0)];
    const geoLine2 = new THREE.BufferGeometry().setFromPoints(points2);
    const line2 = new THREE.Line(geoLine2, materialLine2);
    scene.add(line2);
    
    let time = 0;
    
    let isDeadman = false;
    let isReject = false;
    let pulseSpeed = 1;
    let targetIntensity = 1;
    
    const handleResize = () => {
      if (!mountRef.current) return;
      camera.aspect = mountRef.current.clientWidth / mountRef.current.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mountRef.current.clientWidth, mountRef.current.clientHeight);
    };
    window.addEventListener('resize', handleResize);
    
    const animate = () => {
      requestAnimationFrame(animate);
      
      time += 0.01 * pulseSpeed;
      
      if (lastCycleResult) {
        isDeadman = lastCycleResult.deadman;
        isReject = lastCycleResult.mode === "SENTRA_REJECT";
      }
      
      if (isDeadman) {
        // DEADMAN: Red alert, frozen motion
        pulseSpeed = THREE.MathUtils.lerp(pulseSpeed, 0.1, 0.05);
        targetIntensity = 2 + Math.sin(time * 20) * 1.5;
        
        scene.fog!.color.lerp(new THREE.Color(0x220000), 0.05);
        
        heartMat.color.lerp(new THREE.Color(0x330000), 0.05);
        heartMat.emissive.lerp(new THREE.Color(0x330000), 0.05);
        heartCoreMat.color.lerp(new THREE.Color(0xff0000), 0.05);
        
        sentraCoreMat.emissive.lerp(new THREE.Color(0xff0000), 0.1);
        sentraRingMat.color.lerp(new THREE.Color(0xff0000), 0.1);
        sentraRingMat.emissive.lerp(new THREE.Color(0xff0000), 0.1);
        
        pointLight.color.lerp(new THREE.Color(0xff0000), 0.1);
        pointLight2.color.lerp(new THREE.Color(0xff0000), 0.1);
        pointLight.intensity = targetIntensity;
        pointLight2.intensity = targetIntensity;

        nodes.forEach(n => (n.material as THREE.MeshBasicMaterial).color.lerp(new THREE.Color(0xff0000), 0.1));
        
      } else if (isReject) {
        // REJECT: Orange/Warning, sharp pulsing
        pulseSpeed = THREE.MathUtils.lerp(pulseSpeed, 2.5, 0.05);
        targetIntensity = 1 + Math.sin(time * 10) * 0.5;

        scene.fog!.color.lerp(new THREE.Color(0x1a0a00), 0.05);

        heartMat.color.lerp(new THREE.Color(0xff5500), 0.05);
        heartMat.emissive.lerp(new THREE.Color(0xff5500), 0.05);
        heartCoreMat.color.lerp(new THREE.Color(0xffaa00), 0.05);

        sentraCoreMat.emissive.lerp(new THREE.Color(0xff5500), 0.1);
        sentraRingMat.color.lerp(new THREE.Color(0xffaa00), 0.1);
        sentraRingMat.emissive.lerp(new THREE.Color(0xffaa00), 0.1);

        pointLight.color.lerp(new THREE.Color(0xffaa00), 0.1);
        pointLight2.color.lerp(new THREE.Color(0xffaa00), 0.1);
        
        nodes.forEach(n => (n.material as THREE.MeshBasicMaterial).color.lerp(new THREE.Color(0xff5500), 0.1));

      } else {
        // PASS: Cyan/Blue, smooth flowing
        pulseSpeed = THREE.MathUtils.lerp(pulseSpeed, 1, 0.05);
        targetIntensity = 1;

        scene.fog!.color.lerp(new THREE.Color(0x020202), 0.05);

        heartMat.color.lerp(new THREE.Color(0x00ffff), 0.05);
        heartMat.emissive.lerp(new THREE.Color(0x00ffff), 0.05);
        heartCoreMat.color.lerp(new THREE.Color(0x00ffff), 0.05);

        sentraCoreMat.emissive.lerp(new THREE.Color(0x0044aa), 0.1);
        sentraRingMat.color.lerp(new THREE.Color(0x0088ff), 0.1);
        sentraRingMat.emissive.lerp(new THREE.Color(0x0088ff), 0.1);

        pointLight.color.lerp(new THREE.Color(0x00ffff), 0.1);
        pointLight2.color.lerp(new THREE.Color(0xffaa00), 0.1);
        pointLight.intensity = THREE.MathUtils.lerp(pointLight.intensity, targetIntensity, 0.1);
        pointLight2.intensity = THREE.MathUtils.lerp(pointLight2.intensity, targetIntensity, 0.1);
        
        nodes.forEach(n => (n.material as THREE.MeshBasicMaterial).color.lerp(new THREE.Color(0x00ffff), 0.1));
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
    
    animate();
    
    return () => {
      window.removeEventListener('resize', handleResize);
      renderer.dispose();
      if (mountRef.current && renderer.domElement.parentNode === mountRef.current) {
        mountRef.current.removeChild(renderer.domElement);
      }
    };
  }, [lastCycleResult]);

  if (webglError) {
    const deadman = lastCycleResult?.deadman ?? false;
    return (
      <div className="w-full h-full flex items-center justify-center bg-[#050508] text-slate-200 font-mono text-sm p-6 relative">
        {deadman && <div className="absolute inset-0 border-4 border-red-500/50 animate-pulse" />}
        <div className="flex flex-col items-center gap-6">
          <div className="flex items-center gap-8">
            <div className="flex flex-col items-center gap-2">
              <div className={`w-16 h-16 rounded-full ${deadman ? 'bg-red-900/50 border border-red-500' : 'bg-cyan-500/20 border border-cyan-400 animate-pulse'} flex items-center justify-center`}>
                <div className={`w-8 h-8 rounded-full ${deadman ? 'bg-red-500' : 'bg-cyan-400'}`} />
              </div>
              <span className={`text-xs font-bold uppercase tracking-widest ${deadman ? 'text-red-400' : 'text-cyan-400'}`}>HEART</span>
            </div>
            <div className={`font-black tracking-widest ${deadman ? 'text-red-500' : 'text-cyan-500'}`}>----&gt;</div>
            <div className="flex flex-col items-center gap-2">
              <div className={`w-16 h-16 rotate-45 border-2 flex items-center justify-center ${deadman ? 'border-red-500 bg-red-900/30' : 'border-blue-400 bg-blue-900/20'}`}>
                <div className={`w-6 h-6 rotate-45 ${deadman ? 'bg-red-500' : 'bg-blue-400'}`} />
              </div>
              <span className={`text-xs font-bold uppercase tracking-widest ${deadman ? 'text-red-400' : 'text-blue-400'}`}>SENTRA</span>
            </div>
            <div className={`font-black tracking-widest ${deadman ? 'text-red-500' : 'text-amber-500'}`}>----&gt;</div>
            <div className="flex flex-col items-center gap-2">
              <div className="flex flex-col-reverse gap-1">
                {[0,1,2,3,4].map(i => (
                  <div key={i} className={`w-16 h-2 ${deadman ? 'bg-red-900 border border-red-500' : 'bg-amber-500/80 border border-amber-400'} opacity-${80 - i*10}`} />
                ))}
              </div>
              <span className={`text-xs font-bold uppercase tracking-widest ${deadman ? 'text-red-400' : 'text-amber-400'}`}>YAWAR</span>
            </div>
          </div>
          {deadman && (
            <div className="text-red-500 font-bold text-sm uppercase tracking-widest animate-pulse mt-8 border border-red-500/50 bg-red-500/10 px-6 py-2">
              ▲ DEADMAN ENGAGED — pipeline frozen
            </div>
          )}
          <div className="text-slate-500 text-[10px] mt-8 max-w-md text-center opacity-50">
            WebGL unavailable in this preview.
          </div>
        </div>
      </div>
    );
  }

  return <div ref={mountRef} className="w-full h-full" />;
}