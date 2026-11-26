      else if(okZ){boat.position.z=nz;boat.power*=Math.exp(-dt*2.4);}
      else{
        // Gently nudge away from shallow bank toward deeper water
        const dP=field.waterAt(boat.position.x+2,boat.position.z).depth-field.waterAt(boat.position.x-2,boat.position.z).depth;
        const dQ=field.waterAt(boat.position.x,boat.position.z+2).depth-field.waterAt(boat.position.x,boat.position.z-2).depth;
        const gL=Math.hypot(dP,dQ);
        if(gL>.05){
          const px=boat.position.x+(dP/gL)*Math.min(Math.abs(boat.speed)*dt*.5,.45);
          const pz=boat.position.z+(dQ/gL)*Math.min(Math.abs(boat.speed)*dt*.5,.45);
          if(field.waterAt(px,pz).depth>minDraft){boat.position.x=px;boat.position.z=pz;}
        }
        boat.speed*=Math.exp(-dt*5);boat.power*=Math.exp(-dt*8);
      }
    }
    floatStep(dt,t);boat.updateMatrixWorld(true);KIT.animate(dt,boat.power,ST.lean);
    nightLights();wakeStep(dt);sprayStep(dt);boatLight();
    original.uSeaWake.value=wkA.texture;original.uSeaWakeBox.value.copy(WU.uWi.value);
    original.uSeaWakeStrength.value=WU.uWk.value;
    state.x=lastX=boat.position.x;state.z=lastZ=boat.position.z;state.heading=-boat.heading-Math.PI/2;state.speed=boat.speed;
    if(!options.getDrag()&&document.pointerLockElement!==options.el){const look=options.getYaw(),angle=((state.heading-look+Math.PI*3)%(Math.PI*2))-Math.PI;options.setYaw(look+angle*(1-Math.exp(-dt*1.4)));}
    options.onStats(Math.abs(boat.speed)*1.944,((state.heading*180/Math.PI+90)%360+360)%360);
    cameras(dt,t);
  }
  function idle(dt,t){
    if(!hasSailed)return;idleTime+=dt;
    const speed=boat.speed,power=boat.power;boat.speed=boat.power=0;
    ST.evt=0;ST.wash=0;ST.sprayE=0;wakeStep(Math.min(dt,.05));sprayStep(Math.min(dt,.05));
    boat.speed=speed;boat.power=power;
    original.uSeaWake.value=wkA.texture;original.uSeaWakeBox.value.copy(WU.uWi.value);original.uBLk.value=0;
    if(idleTime>25){hasSailed=false;sPts.visible=false;original.uSeaWakeStrength.value=0;}
  }
  return {update,idle,setCamera(value){mode=value;cameraReady=false;camera.fov=value==='Bridge'?75:58;camera.updateProjectionMatrix();},
    setThrottle(value){throttle=clamp(value,-3,8);},right:rightBoat,
    telemetry(){return {throttle,speed:boat.speed||0,power:boat.power||0,roll:ST.roll,pitch:ST.pitch,capsized:ST.cap!==0,camera:mode,time:realTime};},
    dispose(){for(const target of [probeRT,wkA,wkB])target.dispose();for(const mat of [pMesh.material,wkMat,sMat,nlBeamM])mat.dispose();pGeo.dispose();sGeo.dispose();nlBeamG.dispose();sunL.removeFromParent();hemi.removeFromParent();sPts.removeFromParent();}
  };
}
