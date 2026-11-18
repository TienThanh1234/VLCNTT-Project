#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <ArduinoMqttClient.h>
#include <ArduinoJson.h>
#include <esp_timer.h>
#include <esp_arduino_version.h>

// ESP32 Arduino core 3.x. This sketch is independent of every Wokwi header.
// Edit credentials locally. Never commit actual credentials.
const char *WIFI_SSID="CHANGE_ME", *WIFI_PASSWORD="CHANGE_ME";
const char *BROKER="192.168.1.10", *MQTT_USER="rg01", *MQTT_PASSWORD="CHANGE_ME";
const char *PREFIX="rg/rg01";
constexpr bool PROTECTION_INSTALLED=false; // DPST feedback, fuse and rotor guard verified physically.
constexpr bool BROKER_ACL_VERIFIED=false; // separate rg01/backend users and topic ACLs.
constexpr bool TACH_CALIBRATED=false; // verify 10 hand turns == 10 * PPR pulses first.
constexpr uint32_t PPR=1, TACH_TIMEOUT_US=2000000, DEBOUNCE_US=1000;
constexpr float MAX_RPM=1500, MAX_ACCEL=30, MAX_DUTY=.8;
constexpr uint32_t MAX_RUN_MS=30000;
constexpr int PWMA=25, AIN1=27, AIN2=26, STBY=33, SDA_PIN=19, SCL_PIN=23, TACH=17, CUT_FEEDBACK=32;
constexpr uint8_t MPU=0x68;
constexpr uint32_t PERIOD_US=5000;
constexpr int BLOCK_SIZE=20;
WiFiClient transport;
MqttClient mqtt(transport);
portMUX_TYPE mux=portMUX_INITIALIZER_UNLOCKED;
QueueHandle_t blocks;
struct SampleBlock {float xyz[BLOCK_SIZE][3];uint64_t t0;uint32_t blockSeq,sampleSeq;bool gap,clipped,overflow,i2c;char run[65],config[65];};
char runId[65]="idle",configId[65]="unconfigured";
char bootId[33],sessionId[65]={},armNonce[65]={};
bool running=false,armed=false,networkOk=false,imuOk=false,clipping=false;
float appliedDuty=0;
uint64_t lastSampleUs=0,lastEdgeUs=0,pulsePeriod=0,leaseUntil=0,armUntil=0,runStarted=0;
uint32_t pulseCount=0,commandSeq=0;
bool haveEdge=false;
const char *stopReason="boot";
uint32_t envelopeSeq=0;

uint64_t clockUs(){return (uint64_t)esp_timer_get_time();}
void token(char *out){snprintf(out,33,"%08lx%08lx%08lx%08lx",(unsigned long)esp_random(),(unsigned long)esp_random(),(unsigned long)esp_random(),(unsigned long)esp_random());}
bool privateBroker(){IPAddress ip;if(!ip.fromString(BROKER))return false;return ip[0]==10||(ip[0]==192&&ip[1]==168)||(ip[0]==172&&ip[1]>=16&&ip[1]<=31);}
bool protectionReady(){return PROTECTION_INSTALLED&&BROKER_ACL_VERIFIED&&TACH_CALIBRATED&&privateBroker()&&strcmp(MQTT_PASSWORD,"CHANGE_ME")!=0&&digitalRead(CUT_FEEDBACK)==HIGH;}
// Called with mux held. Only the control task touches power outputs after setup.
void stopLocked(const char *reason){running=false;armed=false;appliedDuty=0;leaseUntil=0;armUntil=0;sessionId[0]=0;armNonce[0]=0;stopReason=reason;}
void IRAM_ATTR tachISR(){uint64_t now=esp_timer_get_time();portENTER_CRITICAL_ISR(&mux);uint64_t elapsed=now-lastEdgeUs;
    if(!haveEdge||elapsed>=DEBOUNCE_US){pulsePeriod=haveEdge&&elapsed<TACH_TIMEOUT_US?elapsed:0;lastEdgeUs=now;haveEdge=true;pulseCount++;}portEXIT_CRITICAL_ISR(&mux);}
void safetyTask(void*){
    for(;;){uint64_t now=clockUs();bool ready=protectionReady();
        portENTER_CRITICAL(&mux);
        if(running||armed){
            if(!ready)stopLocked("physical_protection_open_or_missing");
            else if(!networkOk)stopLocked("network_lost");
            else if(!imuOk||now-lastSampleUs>150000)stopLocked("imu_stale");
            else if(clipping)stopLocked("acceleration_limit");
            else if(armed&&now>=armUntil)stopLocked("arm_expired");
            else if(running&&now>=leaseUntil)stopLocked("lease_expired");
            else if(running&&now-runStarted>MAX_RUN_MS*1000ULL)stopLocked("run_time_limit");
            else if(running&&now-runStarted>TACH_TIMEOUT_US&&(!haveEdge||now-lastEdgeUs>=TACH_TIMEOUT_US))stopLocked("tach_timeout");
            else if(running&&pulsePeriod&&now-lastEdgeUs<TACH_TIMEOUT_US&&60000000.0/pulsePeriod/PPR>MAX_RPM)stopLocked("rpm_limit");
        }
        bool on=running;uint8_t pwm=on?lroundf(appliedDuty*255):0;
        // Keep output writes inside the same short critical section as decisions.
        ledcWrite(PWMA,pwm);digitalWrite(AIN1,on?HIGH:LOW);digitalWrite(AIN2,LOW);digitalWrite(STBY,on?HIGH:LOW);
        portEXIT_CRITICAL(&mux);vTaskDelay(pdMS_TO_TICKS(5));
    }
}
bool regWrite(uint8_t reg,uint8_t value){Wire.beginTransmission(MPU);Wire.write(reg);Wire.write(value);return Wire.endTransmission()==0;}
bool regRead(uint8_t reg,uint8_t *out,size_t count){Wire.beginTransmission(MPU);Wire.write(reg);if(Wire.endTransmission(false)!=0||Wire.requestFrom((int)MPU,(int)count)!=(int)count)return false;for(size_t i=0;i<count;i++)out[i]=Wire.read();return true;}
bool configureImu(){uint8_t value;return regRead(0x75,&value,1)&&(value&0x7e)==0x68&&regWrite(0x6b,1)&&regWrite(0x1a,3)&&regWrite(0x19,4)&&regWrite(0x1c,8)&&regWrite(0x23,0x08)&&regWrite(0x6a,0x44)&&regRead(0x1a,&value,1)&&value==3&&regRead(0x19,&value,1)&&value==4&&regRead(0x1c,&value,1)&&value==8;}
void samplerTask(void*){
    SampleBlock block={};int used=0;uint32_t seq=0,sampleSeq=0;uint64_t nextTime=0,firstWall=0;uint32_t sampled=0;bool gap=true,overflow=false,i2c=false;
    for(;;){uint8_t status=0,countBytes[2];bool ok=regRead(0x3a,&status,1)&&regRead(0x72,countBytes,2);
        int count=ok?((countBytes[0]<<8)|countBytes[1]):0;
        if(!ok||(status&0x10)||count>=1024){
            gap=true;overflow|=(status&0x10)||count>=1024;i2c|=!ok;used=0;nextTime=0;
            regWrite(0x6a,0x44);portENTER_CRITICAL(&mux);imuOk=false;portEXIT_CRITICAL(&mux);
            if(!ok){vTaskDelay(pdMS_TO_TICKS(100));configureImu();}vTaskDelay(pdMS_TO_TICKS(10));continue;
        }
        int available=count/6;uint64_t drainAt=clockUs();
        if(available&&!nextTime)nextTime=drainAt-(available-1)*PERIOD_US;
        for(int j=0;j<available;j++){
            uint8_t bytes[6];if(!regRead(0x74,bytes,6)){i2c=true;gap=true;used=0;nextTime=0;portENTER_CRITICAL(&mux);imuOk=false;portEXIT_CRITICAL(&mux);break;}
            if(used==0){block={};block.t0=nextTime;block.sampleSeq=sampleSeq;block.gap=gap;block.overflow=overflow;block.i2c=i2c;
                portENTER_CRITICAL(&mux);strlcpy(block.run,runId,65);strlcpy(block.config,configId,65);portEXIT_CRITICAL(&mux);gap=overflow=i2c=false;}
            bool over=false;
            for(int axis=0;axis<3;axis++){int16_t raw=(int16_t)((uint16_t(bytes[2*axis])<<8)|bytes[2*axis+1]);float value=raw/8192.0f*9.80665f;block.xyz[used][axis]=value;block.clipped|=abs((int)raw)>=32700;over|=fabsf(value)>MAX_ACCEL;}
            nextTime+=PERIOD_US;sampleSeq++;sampled++;
            if(!firstWall)firstWall=drainAt;
            portENTER_CRITICAL(&mux);imuOk=true;lastSampleUs=drainAt;clipping=over||block.clipped;portEXIT_CRITICAL(&mux);
            if(++used==BLOCK_SIZE){block.blockSeq=seq++;if(xQueueSend(blocks,&block,0)!=pdTRUE)gap=true;used=0;}
        }
        // Independent wall-clock observation; timestamps reconstructed from FIFO cadence alone do not prove Fs.
        if(firstWall&&drainAt-firstWall>=30000000ULL){Serial.printf("SAMPLER elapsed_us=%llu samples=%lu fs_observed=%.4f\n",drainAt-firstWall,(unsigned long)sampled,1000000.0*sampled/(drainAt-firstWall));firstWall=drainAt;sampled=0;}
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}
void envelope(JsonDocument &d){d["schema_version"]=2;d["device_id"]="rg01";d["source"]="measured";d["data_origin"]="physical";d["boot_id"]=bootId;d["seq"]=envelopeSeq++;d["t_device_ms"]=clockUs()/1000;}
bool publish(const char *suffix,JsonDocument &doc){String text;serializeJson(doc,text);int qos=strcmp(suffix,"ack")==0?1:0;
    bool ok=mqtt.beginMessage(String(PREFIX)+"/"+suffix,(unsigned long)text.length(),false,qos)&&mqtt.write((const uint8_t*)text.c_str(),text.length())==text.length()&&mqtt.endMessage()==1;
    if(!ok){portENTER_CRITICAL(&mux);networkOk=false;stopLocked("publish_failed");portEXIT_CRITICAL(&mux);}return ok;}
void stateMessage(){JsonDocument d;envelope(d);bool safe=protectionReady();portENTER_CRITICAL(&mux);
    d["running"]=running;d["duty"]=running?appliedDuty:0;d["phase"]=running?"RUNNING":armed?"ARMED":"OFF";d["imu_ok"]=imuOk&&clockUs()-lastSampleUs<150000;d["stop_reason"]=stopReason;d["run_id"]=runId;d["config_id"]=configId;portEXIT_CRITICAL(&mux);d["safety_ready"]=safe;publish("state",d);}
void rpmMessage(){JsonDocument d;envelope(d);uint64_t now=clockUs();portENTER_CRITICAL(&mux);uint64_t p=pulsePeriod,last=lastEdgeUs;uint32_t count=pulseCount;bool edge=haveEdge,on=running;portEXIT_CRITICAL(&mux);
    const char *quality=edge&&p&&now-last<TACH_TIMEOUT_US?"ok":!on&&TACH_CALIBRATED&&now-last>TACH_TIMEOUT_US?"stopped":!edge?"uninitialized":"no_recent_pulses";
    if(strcmp(quality,"ok")==0){d["rpm"]=60000000.0/p/PPR;d["period_us"]=p;}else{d["period_us"]=nullptr;if(strcmp(quality,"stopped")==0)d["rpm"]=0;else d["rpm"]=nullptr;}
    d["last_edge_device_us"]=last;d["pulses"]=count;d["ppr"]=PPR;d["quality"]=quality;d["unit"]="rpm";publish("telemetry/rpm",d);
}
void onCommand(int size){
    if(size<=0||size>2048){mqtt.stop();return;}String text;while(mqtt.available()){int c=mqtt.read();if(c<0){mqtt.stop();return;}text+=(char)c;}
    JsonDocument cmd;if(mqtt.messageRetain()||mqtt.messageTopic()!=String(PREFIX)+"/cmd/motor"||deserializeJson(cmd,text))return;
    const char *id=cmd["command_id"]|"",*action=cmd["action"]|"",*session=cmd["session_id"]|"",*nonce=cmd["nonce"]|"";
    if(!*id||strlen(id)>64||!*session||strlen(session)>64||!*nonce||strlen(nonce)>64)return;
    bool valid=cmd["schema_version"].is<int>()&&cmd["schema_version"].as<int>()==2&&String(cmd["device_id"]|"")=="rg01"&&String(cmd["source"]|"")=="measured"&&String(cmd["data_origin"]|"")=="physical";
    uint64_t now=clockUs(),deadline=cmd["not_after_device_ms"].as<uint64_t>()*1000;uint32_t lease=cmd["lease_ms"]|0,sequence=cmd["command_seq"]|0;
    bool safe=protectionReady(),ok=false;const char *reason="invalid_contract";char replyNonce[65];strlcpy(replyNonce,nonce,65);
    char newNonce[33];token(newNonce);
    portENTER_CRITICAL(&mux);
    if(valid&&String(cmd["boot_id"]|"")!=bootId)reason="wrong_boot";
    else if(valid&&(!cmd["not_after_device_ms"].is<uint64_t>()||deadline<=now||deadline-now>2000000))reason="expired_deadline";
    else if(valid){
        if(strcmp(action,"stop")==0){stopLocked("command_stop");ok=true;reason="stopped_output_rotor_may_coast";}
        else if(strcmp(action,"configure")==0){const char *r=cmd["run_id"]|"",*c=cmd["config_id"]|"";
            if(!running&&!armed&&*r&&strlen(r)<=64&&*c&&strlen(c)<=64){strlcpy(runId,r,65);strlcpy(configId,c,65);ok=true;reason="acquisition_configured";}else reason="configure_requires_OFF_and_ids";
        }
        else if(!safe||!networkOk||!imuOk||now-lastSampleUs>150000||clipping)reason="safety_not_ready";
        else if(strcmp(action,"arm")==0){if(running||armed)reason="already_armed_or_running";else{strlcpy(sessionId,session,65);strlcpy(armNonce,newNonce,65);strlcpy(replyNonce,newNonce,65);armed=true;armUntil=now+2000000;commandSeq=sequence;ok=true;reason="armed_waiting_START";}}
        else if(strcmp(sessionId,session)!=0||strcmp(armNonce,nonce)!=0)reason="wrong_session_or_nonce";
        else if(sequence<=commandSeq)reason="duplicate_or_old_command_sequence";
        else if(!cmd["command_seq"].is<uint32_t>()||!cmd["duty"].is<float>()||!isfinite(cmd["duty"].as<float>())||cmd["duty"].as<float>()<0||cmd["duty"].as<float>()>MAX_DUTY||lease<500||lease>2000)reason="invalid_duty_lease_or_sequence";
        else if(strcmp(action,"start")==0){if(!armed||running||now>=armUntil)reason="arm_expired_or_nonce_used";else{armed=false;running=true;runStarted=now;ok=true;reason="started_output_wait_for_RPM";}}
        else if(strcmp(action,"renew")==0||strcmp(action,"set_duty")==0){if(!running||now>=leaseUntil){stopLocked("lease_expired");reason="not_running_or_lease_expired";}else{ok=true;reason="renewed";}}
        else reason="unknown_action";
        if(ok&&running){appliedDuty=roundf(cmd["duty"].as<float>()*255)/255;leaseUntil=now+lease*1000ULL;commandSeq=sequence;}
    }
    bool on=running;float duty=appliedDuty;portEXIT_CRITICAL(&mux);
    JsonDocument ack;envelope(ack);ack["command_id"]=id;ack["session_id"]=session;ack["nonce"]=replyNonce;ack["accepted"]=ok;ack["running"]=on;ack["duty_applied"]=duty;ack["reason"]=reason;publish("ack",ack);stateMessage();
}
void setup(){
    pinMode(STBY,OUTPUT);digitalWrite(STBY,LOW);pinMode(AIN1,OUTPUT);digitalWrite(AIN1,LOW);pinMode(AIN2,OUTPUT);digitalWrite(AIN2,LOW);
    ledcAttach(PWMA,20000,8);ledcWrite(PWMA,0);pinMode(CUT_FEEDBACK,INPUT_PULLDOWN);pinMode(TACH,INPUT);
    Serial.begin(115200);token(bootId);blocks=xQueueCreate(12,sizeof(SampleBlock));
    Wire.begin(SDA_PIN,SCL_PIN);Wire.setClock(400000);Wire.setTimeOut(25);imuOk=configureImu();
    attachInterrupt(digitalPinToInterrupt(TACH),tachISR,RISING);
    xTaskCreatePinnedToCore(safetyTask,"safety",4096,nullptr,4,nullptr,1);
    xTaskCreatePinnedToCore(samplerTask,"fifo",4096,nullptr,3,nullptr,1);
    mqtt.setId(String("rg01-")+bootId);mqtt.setUsernamePassword(MQTT_USER,MQTT_PASSWORD);mqtt.setKeepAliveInterval(1000);mqtt.setConnectionTimeout(500);mqtt.onMessage(onCommand);
    JsonDocument will;envelope(will);will["online"]=false;String body;serializeJson(will,body);mqtt.beginWill(String(PREFIX)+"/availability",(unsigned long)body.length(),false,1);mqtt.print(body);mqtt.endWill();
    WiFi.begin(WIFI_SSID,WIFI_PASSWORD);Serial.printf("PHYSICAL v2 boot=%s protection=%d IMU=%d\n",bootId,PROTECTION_INSTALLED,imuOk);
}
void loop(){static uint32_t attempt=0,stateAt=0,rpmAt=0;
    bool connected=WiFi.status()==WL_CONNECTED&&mqtt.connected();portENTER_CRITICAL(&mux);networkOk=connected;if(!connected&&(running||armed))stopLocked("network_lost");portEXIT_CRITICAL(&mux);
    if(!connected){if(WiFi.status()==WL_CONNECTED&&millis()-attempt>2000){attempt=millis();if(mqtt.connect(BROKER,1883)){transport.setNoDelay(true);mqtt.subscribe(String(PREFIX)+"/cmd/motor",1);JsonDocument d;envelope(d);d["online"]=true;publish("availability",d);stateMessage();}}delay(5);return;}
    mqtt.poll();if(millis()-stateAt>=200){stateAt=millis();stateMessage();}if(millis()-rpmAt>=100){rpmAt=millis();rpmMessage();}
    SampleBlock b;if(xQueueReceive(blocks,&b,0)==pdTRUE){
        if(clockUs()>b.t0+500000){return;} // Drop stale queued blocks; sequence discontinuity identifies gap.
        JsonDocument d;envelope(d);d["run_id"]=b.run;d["config_id"]=b.config;d["block_seq"]=b.blockSeq;d["sample_seq0"]=b.sampleSeq;d["t0_device_us"]=b.t0;d["sample_period_us"]=PERIOD_US;d["unit"]="m/s2";
        JsonObject q=d["quality"].to<JsonObject>();q["gap"]=b.gap;q["clipping"]=b.clipped;q["fifo_overflow"]=b.overflow;q["i2c_error"]=b.i2c;q["missing_samples"]=b.gap;
        JsonArray samples=d["samples"].to<JsonArray>();for(int i=0;i<BLOCK_SIZE;i++){JsonArray row=samples.add<JsonArray>();for(int j=0;j<3;j++)row.add(b.xyz[i][j]);}publish("telemetry/vibration_block",d);
    }delay(1);
}
