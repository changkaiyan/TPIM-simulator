var jquery = require('jquery');
import { GoldenLayout } from 'golden-layout';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import { fabric } from "fabric";
import { pow, string, toDependencies, zeros } from 'mathjs'
import * as echarts from 'echarts';
var MarkdownIt = require("markdown-it"),
  md = new MarkdownIt();

var nvm_memory_file = ""
var pimsystem = undefined

//-----电平设置区域(方便模拟器识别)------
const nand_in_v = -1
const nand_out_v = -2
const set_row_v = -3
const set_col_v = -4
const reset_row_v = -5
const reset_col_v = -6
const cnor_in_v = -7
const cnor_out_v = -8
const rnor_in_v = -9
const rnor_out_v = -10
const ror_in_v = -12
const ror_out_v = -13
const cor_in_v = -14
const cor_out_v = -15
const cxor_in_v = -16
const rxor_out_v = -17
const logic_line_v = -18
const cxor_out_v = -19
const rxor_in_v = -20
const high_resistance = -21
const read_voltage = 1



class PIMSystem {
  constructor(max_row, max_col, adc_number, shift_add_number, serialin, serialout, monacoout) {
    this.serialout = serialout
    this.serialin = serialin
    this.monacoout = monacoout
    console.assert(serialin >= max_col * max_row && serialout >= max_col * max_row, "serial address set error.")
    //注意串口地址要大于xb地址
    //----------------basic PIM structure-------------------
    this.max_row = max_row;
    this.max_col = max_col;
    this.adc_number = adc_number;
    this.shift_add_number = shift_add_number
    this.nvm_cells = zeros(max_row, max_col).toArray();//conductance电导（非电阻）
    //adc在功能模拟时消去
    this.shiftandadd_in_begin_column = 0;//8-bits wire
    this.shiftandadd_in_length = 0;//8-bits wire
    this.shiftandadd_in_to_row_addrs = 0;//8-bits wire
    this.shiftandadd_in_to_col_addrs = 0;//8-bits wire,-1 represents buffer before adc
    //----------------Memory controller structure--------------
    this.init_flash = []//每个元素是一条字符串形式的指令
    this.dataflow_flash = []
    this.row_input_voltages = zeros(max_row)//列输入电平:1,0,H(-1)
    this.col_input_voltages = zeros(max_col)//行输入电平:1,0,H(-1)
    this.col_current = zeros(max_col)//列线电流
    //行线电流不被使用，因此NVM是一个电压控制电压器件，和CMOS相似
    //-----------default configuration--------------(集成电路相关数据)
    
    this.dataflow_flash_pc = 0
    this.total_inst_num=0
    //--------------------硬件参数-------------------
    this.nvm_reset_latency=10//(ns)
    this.nvm_set_latency=100//(ns)
    this.endurance=1e10//次
    //默认p端接WL，n端接BL。
    this.cell_threshold = 0.5//>0.5V时，nvm cell发生变化. <=0.5V时DAC开启，>0.5V时DAC关闭，通用电源开启
    this.switch_energy=15//(uW)

    //https://www.youtube.com/watch?v=mCQOy7r5DT0&t=146s
    //10×10nm2 Hf/HfOx crossbar resistive RAM with excellent performance, reliability and low-energy operation
    //-------------动态统计参数（energy、latency应该使用freepdk测量的数据）---------------------
    this.latency=0
    this.max_endurance=0
    this.energy=0
    this.utility=0
  }

  // TODO: endurance
  // TODO: latency
  // TODO: energy
  // TODO: utility

  decode_init() {
    for (var i = 0; i < this.init_flash.length; i++) {
      let inst = this.init_flash[i].split(" ")
      this.exec_inst(inst)
    }
  }
  //指令解码
  decoder_one_inst() {
    this.total_inst_num+=1
    if (this.dataflow_flash == undefined) {
      alert("can not read assembly for flash")
      throw "can not read assembly for flash"
    }
    if (this.dataflow_flash_pc >= this.dataflow_flash.length) {
      
      this.dataflow_flash_pc = 0
      
    }
    document.getElementById("currentpc").innerHTML="Current PC:"+this.dataflow_flash_pc
      document.getElementById("currentloc").innerHTML="Current Loc:"+(this.dataflow_flash_pc+this.init_flash.length+2)
      document.getElementById("currentinst").innerHTML="Current Inst:"+this.dataflow_flash[this.dataflow_flash_pc]
    var inst = this.dataflow_flash[this.dataflow_flash_pc].split(" ")
    this.exec_inst(inst)
    this.dataflow_flash_pc += 1
    
  }

  exec_inst(inst_split) {
    if (inst_split[0] == "write_bits") {
      let bits = Number(inst_split[1], 0)
      let row = Number(inst_split[2], 0)
      let col = Number(inst_split[3], 0)
      let value = Number(inst_split[4], 0)
      this.write_to(value, row, col, bits)
    }
    else if (inst_split[0] == "read_bits") {
      let bits = Number(inst_split[1], 0)
      let row = Number(inst_split[2], 0)
      let col = Number(inst_split[3], 0)
      let trow = Number(inst_split[4], 0)
      let tcol = Number(inst_split[5], 0)
      let value = this.get_int(row, col, bits)
      this.write_to(value, trow, tcol, bits)
    }
    else if (inst_split[0] == "indirect_write_bits") {
      let bits = Number(inst_split[1], 0)
      let row_row = Number(inst_split[2], 0)
      let row_col = Number(inst_split[3], 0)
      let col_row = Number(inst_split[4], 0)
      let col_col = Number(inst_split[5], 0)
      let trow = Number(inst_split[6], 0)
      let tcol = Number(inst_split[7], 0)
      let srow = this.get_int(row_row, row_col, 8)//默认XB的大小限定在256*256之间
      let scol = this.get_int(col_row, col_col, 8)
      let value = this.get_int(srow, scol, bits)
      this.write_to(value, trow, tcol, bits)
    }
    else if (inst_split[0] == "clear_input") {
      for (var i = 0; i < this.row_input_voltages.length; i++) {
        this.row_input_voltages[i] = 0
      }
    }
    else if (inst_split[0] == "copy_bits") {
      let bits = Number(inst_split[1], 0)
      let row = Number(inst_split[2], 0)
      let col = Number(inst_split[3], 0)
      let trow = Number(inst_split[4], 0)
      let tcol = Number(inst_split[5], 0)
      let value = this.get_int(row, col, bits)
      this.write_to(value, trow, tcol, bits)
    }
    else if (inst_split[0] == "sa_number") {
      let bits = Number(inst_split[1], 0)
      let begin_col = Number(inst_split[2], 0)
      let trow = Number(inst_split[3], 0)
      let tcol = Number(inst_split[4], 0)
      this.set_col_high_resistance()
      this.update_cell()
      this.shiftandadd_in_begin_column = begin_col
      this.shiftandadd_in_length = bits
      this.shiftandadd_in_to_col_addrs = tcol
      this.shiftandadd_in_to_row_addrs = trow
      this.shift_and_add(bits)
    }
    else if (inst_split[0] == "nand3") {

      let bits = Number(inst_split[1], 0)//<=3
      let scol = Number(inst_split[2], 0)//
      let tcol = Number(inst_split[3], 0)
      let row = Number(inst_split[4], 0)
      console.assert((bits == 3 || bits == 2), "error in processing nand3")
      this.set_high_resistance()
      this.row_input_voltages[row] = logic_line_v
      for (var i = 0; i < bits; i++) {
        this.col_input_voltages[scol + i] = nand_in_v
      }

      this.col_input_voltages[tcol] = nand_out_v
      this.update_cell()
    }
    else if (inst_split[0] == "cor") {
      let bits = Number(inst_split[1], 0)//
      let srow = Number(inst_split[2], 0)//
      let trow = Number(inst_split[3], 0)
      let col = Number(inst_split[4], 0)
      this.set_high_resistance()
      //开始逻辑编程
      this.col_input_voltages[col] = logic_line_v
      for (var i = 0; i < bits; i++) {
        this.row_input_voltages[srow + i] = cor_in_v
      }
      this.row_input_voltages[trow] = cor_out_v
      this.update_cell()
    }
    else if (inst_split[0] == "cnor") {
      let bits = Number(inst_split[1], 0)//
      let srow = Number(inst_split[2], 0)//
      let trow = Number(inst_split[3], 0)
      let col = Number(inst_split[4], 0)
      this.set_high_resistance()
      this.col_input_voltages[col] = logic_line_v
      for (var i = 0; i < bits; i++) {
        this.row_input_voltages[srow + i] = cnor_in_v
      }
      this.row_input_voltages[trow] = cnor_out_v

      this.update_cell()
    }
    else if (inst_split[0] == "ror") {
      let bits = Number(inst_split[1], 0)//
      let scol = Number(inst_split[2], 0)//
      let tcol = Number(inst_split[3], 0)
      let row = Number(inst_split[4], 0)
      this.set_high_resistance()
      this.row_input_voltages[row] = logic_line_v
      for (var i = 0; i < bits; i++) {
        this.col_input_voltages[scol + i] = ror_in_v
      }
      this.col_input_voltages[tcol] = ror_out_v

      this.update_cell()
    }
    else if (inst_split[0] == "rnor") {
      let bits = Number(inst_split[1], 0)//
      let scol = Number(inst_split[2], 0)//
      let tcol = Number(inst_split[3], 0)
      let row = Number(inst_split[4], 0)
      this.set_high_resistance()
      this.row_input_voltages[row] = logic_line_v
      for (var i = 0; i < bits; i++) {
        this.col_input_voltages[scol + i] = rnor_in_v
      }
      this.col_input_voltages[tcol] = rnor_out_v

      this.update_cell()
    }
    else if (inst_split[0] == "rxor") {
      let col0 = Number(inst_split[1], 0)//
      let col1 = Number(inst_split[2], 0)//
      let tcol = Number(inst_split[3], 0)
      let row = Number(inst_split[4], 0)
      this.set_high_resistance()
      this.row_input_voltages[row] = logic_line_v

      this.col_input_voltages[col0] = rxor_in_v
      this.col_input_voltages[col1] = rxor_in_v
      this.col_input_voltages[tcol] = rxor_out_v

      this.update_cell()
    }
    else if (inst_split[0] == "cxor") {
      let row0 = Number(inst_split[1], 0)//
      let row1 = Number(inst_split[2], 0)//
      let trow = Number(inst_split[3], 0)
      let col = Number(inst_split[4], 0)
      this.set_high_resistance()
      this.col_input_voltages[col] = logic_line_v
      this.row_input_voltages[row0] = cxor_in_v
      this.row_input_voltages[row1] = cxor_in_v
      this.row_input_voltages[trow] = cxor_out_v

      this.update_cell()
    }
  }

  //根据电平更新nvm cell，注意逻辑运算表示，列电平为高阻。
  update_cell() {
    //按列执行逻辑运算
    var logic_result = zeros(this.max_row);
    for (var i = 0; i < this.max_row; i += 1) {
      logic_result[i] = -1;
    }

    for (var i = 0; i < this.max_row; i += 1) {
      for (var j = 0; j < this.max_col; j += 1) {
        //nand
        if (this.col_input_voltages[j] == nand_in_v && this.row_input_voltages[i] == logic_line_v) {
          if (logic_result[i] == -1) {
            logic_result[i] = (this.nvm_cells[i][j] == 1)
          }
          else {
            logic_result[i] = (this.nvm_cells[i][j] == 1) && logic_result[i]
          }
        }
        //rnor
        if (this.col_input_voltages[j] == rnor_in_v && this.row_input_voltages[i] == logic_line_v) {
          if (logic_result[i] == -1) {
            logic_result[i] = (this.nvm_cells[i][j] == 1)
          }
          else {
            logic_result[i] = (this.nvm_cells[i][j] == 1) || logic_result[i]
          }
        }
        //ror
        if (this.col_input_voltages[j] == ror_in_v && this.row_input_voltages[i] == logic_line_v) {
          if (logic_result[i] == -1) {
            logic_result[i] = !(this.nvm_cells[i][j] == 1)
          }
          else {
            logic_result[i] = (!(this.nvm_cells[i][j] == 1)) && logic_result[i]

          }
        }
        //rxor
        if (this.col_input_voltages[j] == rxor_in_v && this.row_input_voltages[i] == logic_line_v) {
          if (logic_result[i] == -1) {
            logic_result[i] = (this.nvm_cells[i][j] == 1)
          }
          else {
            logic_result[i] = ((this.nvm_cells[i][j] == 1) && logic_result[i]) || ((!this.nvm_cells[i][j] == 1) && (!logic_result[i]))
          }
        }
      }
      logic_result[i] = !(logic_result[i])
    }

    for (var j = 0; j < this.max_col; j += 1) {
      if (this.col_input_voltages[j] == nand_out_v || this.col_input_voltages[j] == rnor_out_v
        || this.col_input_voltages[j] == ror_out_v || this.col_input_voltages[j] == rxor_out_v) {
        for (var i = 0; i < this.max_row; i += 1) {
          if (this.row_input_voltages[i] == logic_line_v) {
            this.nvm_cells[i][j] = Number(logic_result[i])
          }
        }
      }
    }
    //按行执行逻辑运算
    logic_result = zeros(this.max_col);
    for (var j = 0; j < this.max_col; j += 1) {
      logic_result[j] = -1;
    }


    for (var j = 0; j < this.max_col; j += 1) {
      for (var i = 0; i < this.max_row; i += 1) {

        //cnor
        if (this.row_input_voltages[i] == cnor_in_v && this.col_input_voltages[j] == logic_line_v) {
          if (logic_result[j] == -1) {
            logic_result[j] = (this.nvm_cells[i][j] == 1)
          }
          else {
            logic_result[j] = (this.nvm_cells[i][j] == 1) || logic_result[j]
          }
        }
        //cor
        if (this.row_input_voltages[i] == cor_in_v && this.col_input_voltages[j] == logic_line_v) {
          if (logic_result[j] == -1) {
            logic_result[j] = !(this.nvm_cells[i][j] == 1)
          }
          else {
            logic_result[j] = (!(this.nvm_cells[i][j] == 1)) && logic_result[j]
          }
        }
        //cxor
        if (this.row_input_voltages[i] == cxor_in_v && this.col_input_voltages[j] == logic_line_v) {
          if (logic_result[j] == -1) {
            logic_result[j] = (this.nvm_cells[i][j] == 1)
          }
          else {
            logic_result[j] = ((this.nvm_cells[i][j] == 1) && logic_result[j]) || ((!this.nvm_cells[i][j] == 1) && (!logic_result[j]))
          }
        }
      }
      logic_result[j] = !(logic_result[j])
    }
    for (var i = 0; i < this.max_row; i += 1) {
      if (this.row_input_voltages[i] == cnor_out_v
        || this.row_input_voltages[i] == cor_out_v || this.row_input_voltages[i] == cxor_out_v) {
        for (var j = 0; j < this.max_col; j += 1) {
          if (this.col_input_voltages[j] == logic_line_v)
            this.nvm_cells[i][j] = Number(logic_result[j])
        }
      }
    }

    //执行写入运算
    for (var i = 0; i < this.max_row; i += 1) {
      for (var j = 0; j < this.max_col; j += 1) {
        if (this.col_input_voltages[j] == set_col_v && this.row_input_voltages[i] == set_row_v) {
          this.nvm_cells[i][j] = 1
        }
        else if (this.col_input_voltages[j] == reset_col_v && this.row_input_voltages[i] == reset_row_v) {
          this.nvm_cells[i][j] = 0
        }
      }
    }
    //执行读取运算
    for (var j = 0; j < this.max_col; j += 1) {
      this.col_current[j] = 0;
      for (var i = 0; i < this.max_row; i += 1) {
        if (this.row_input_voltages[i] > 0)//防止负数表示参杂
          this.col_current[j] += this.row_input_voltages[i] * this.nvm_cells[i][j]
      }
    }
  }
  logical_shift_and_add(outlength) {//做s&a并写入到指定地址横向开始的地方
    var sum = 0
    for (var i = 0; i < this.shiftandadd_in_length; i += 1) {
      sum += (this.col_current[this.shiftandadd_in_begin_column + i] << (i))
    }
    this.write_to(sum, this.shiftandadd_in_to_row_addrs, this.shiftandadd_in_to_col_addrs, outlength)
  }

  shift_and_add(outlength) {//做s&a并写入到指定地址横向开始的地方，用于需要量化的组件
    var sum = 0
    for (var i = 0; i < this.shiftandadd_in_length; i += 1) {
      sum += (this.col_current[this.shiftandadd_in_begin_column + i] << (i))
    }
    sum *= this.cell_threshold
    this.write_to(sum, this.shiftandadd_in_to_row_addrs, this.shiftandadd_in_to_col_addrs, outlength)

  }
  //便捷操作方法（没有并行性）
  write_logic_to(val, row, col) {
    this.nvm_cells[row][col] = Number(val == 1)
  }

  initzeros() {
    this.nvm_cells = zeros(this.max_row, this.max_col).toArray()
  }

  write_to(val, row, col, bits) {
    var nval = val.toString(2).split('').reverse()//前小后大


    if (row * this.max_col + col == this.serialout) {//串口输出
      this.monacoout.setValue(this.monacoout.getValue() + String.fromCharCode(val))
    } else if (col == -1) {//写入电压缓存
      this.set_number_voltage(row, val)
    } else {
      for (var i = 0; i < bits; i += 1) {//XB的左侧存小端，右侧存大端

        if (nval[i] == undefined) {
          this.nvm_cells[row][col + i] = 0;
        }
        else {
          this.nvm_cells[row][col + i] = Number(nval[i])
        }
      }
    }
  }

  get_int(row, col, bits) {
    var val = 0
    for (var i = 0; i < bits; i += 1) {
      if (this.nvm_cells[row][col + i] != 0) {
        val += pow(2, (i))
      }
    }
    return val
  }

  set_col_high_resistance() {

  }

  read_from_write(row0, col0, row1, col1, trow, tcol, bits) {
    var row = this.get_int(row0, col0, bits)
    var col = this.get_int(row1, col1, bits)
    var val = this.get_int(row, col, bits)
    this.write_to(val, trow, tcol, bits)
  }

  set_number_voltage(row, value) {//8-bit,需要量化到指定范围
    this.row_input_voltages[row] = value / this.cell_threshold;
  }

  //无关的电压线放成高阻态
  set_high_resistance() {
    for (var i = 0; i < this.max_col; i += 1) {//无关col置为高阻态
      this.col_input_voltages[i] = high_resistance;
    }
    for (var i = 0; i < this.max_row; i += 1) {//无关row置为高阻态
      this.row_input_voltages[i] = high_resistance;
    }
  }

}


function testpim(out) {
  var tpim = new PIMSystem(20, 20, 1, 1, 400, 401, out)
  //---------------同row的nand3运算(0.75V电压)------------------
  tpim.nvm_cells[0][0] = 0
  tpim.nvm_cells[0][1] = 0
  tpim.nvm_cells[0][4] = 0
  tpim.nvm_cells[0][2] = 0
  for (var i = 0; i < tpim.max_col; i += 1) {//无关col置为高阻态
    tpim.col_input_voltages[i] = high_resistance;
  }

  //开始逻辑编程
  tpim.row_input_voltages[0] = logic_line_v
  tpim.col_input_voltages[0] = nand_in_v
  tpim.col_input_voltages[1] = nand_in_v
  tpim.col_input_voltages[4] = nand_in_v
  tpim.col_input_voltages[2] = nand_out_v
  tpim.update_cell()

  console.log(tpim.nvm_cells[0][2] == 1)
  //------------------同row的nand2运算（0.75V电压）------------------
  tpim.nvm_cells[0][0] = 1
  tpim.nvm_cells[0][1] = 1
  tpim.nvm_cells[0][2] = 0
  for (var i = 0; i < tpim.max_col; i += 1) {//无关col置为高阻态
    tpim.col_input_voltages[i] = high_resistance;
  }

  //开始逻辑编程
  tpim.row_input_voltages[0] = logic_line_v
  tpim.col_input_voltages[0] = nand_in_v
  tpim.col_input_voltages[1] = nand_in_v
  tpim.col_input_voltages[2] = nand_out_v
  tpim.update_cell()

  console.log(tpim.nvm_cells[0][2] == 0)

  //----------------同row的nor运算---------------
  tpim.nvm_cells[0][0] = 0
  tpim.nvm_cells[0][1] = 1
  tpim.nvm_cells[0][4] = 1
  for (var i = 0; i < tpim.max_col; i += 1) {//无关col置为高阻态
    tpim.col_input_voltages[i] = high_resistance;
  }
  //开始逻辑编程
  tpim.row_input_voltages[0] = logic_line_v
  tpim.col_input_voltages[0] = rnor_in_v
  tpim.col_input_voltages[1] = rnor_in_v
  tpim.col_input_voltages[4] = rnor_in_v
  tpim.col_input_voltages[2] = rnor_out_v
  tpim.update_cell()
  console.log("nor")
  console.log(tpim.nvm_cells[0][2] == 0)
  //----------------同col的nor运算---------------
  tpim.nvm_cells[0][0] = 1
  tpim.nvm_cells[1][0] = 1
  tpim.nvm_cells[4][0] = 1
  for (var i = 0; i < tpim.max_row; i += 1) {//无关col置为高阻态
    tpim.row_input_voltages[i] = high_resistance;
  }
  //开始逻辑编程
  tpim.col_input_voltages[0] = logic_line_v
  tpim.row_input_voltages[0] = cnor_in_v
  tpim.row_input_voltages[1] = cnor_in_v
  tpim.row_input_voltages[4] = cnor_in_v
  tpim.row_input_voltages[2] = cnor_out_v
  tpim.update_cell()
  console.log("cnor")
  console.log(tpim.nvm_cells[2][0] == 0)
  //----------------同row的or运算---------------
  tpim.nvm_cells[0][0] = 0
  tpim.nvm_cells[0][1] = 0
  tpim.nvm_cells[0][4] = 0

  for (var i = 0; i < tpim.max_col; i += 1) {//无关col置为高阻态
    tpim.col_input_voltages[i] = high_resistance;
  }
  //开始逻辑编程
  tpim.row_input_voltages[0] = logic_line_v
  tpim.col_input_voltages[0] = ror_in_v
  tpim.col_input_voltages[1] = ror_in_v
  tpim.col_input_voltages[4] = ror_in_v
  tpim.col_input_voltages[2] = ror_out_v
  tpim.update_cell()
  console.log("or")
  console.log(tpim.nvm_cells[0][2] == 0)
  //----------------同col的or运算---------------
  tpim.nvm_cells[0][0] = 1
  tpim.nvm_cells[1][0] = 1
  tpim.nvm_cells[4][0] = 0
  for (var i = 0; i < tpim.max_row; i += 1) {//无关col置为高阻态
    tpim.row_input_voltages[i] = high_resistance;
  }
  //开始逻辑编程
  tpim.col_input_voltages[0] = logic_line_v
  tpim.row_input_voltages[0] = cor_in_v
  tpim.row_input_voltages[1] = cor_in_v
  tpim.row_input_voltages[4] = cor_in_v
  tpim.row_input_voltages[2] = cor_out_v
  tpim.update_cell()
  console.log("cor")
  console.log(tpim.nvm_cells[2][0] == 1)
  //----------------同col的xor运算（仅支持2个操作数）---------------
  tpim.nvm_cells[0][0] = 0
  tpim.nvm_cells[4][0] = 0
  for (var i = 0; i < tpim.max_row; i += 1) {//无关col置为高阻态
    tpim.row_input_voltages[i] = high_resistance;
  }
  //开始逻辑编程
  tpim.col_input_voltages[0] = logic_line_v
  tpim.row_input_voltages[0] = cxor_in_v
  tpim.row_input_voltages[4] = cxor_in_v
  tpim.row_input_voltages[2] = cxor_out_v
  tpim.update_cell()
  console.log("cxor")
  console.assert(tpim.nvm_cells[2][0] == 0)
  //----------------同row的xor运算---------------
  tpim.nvm_cells[0][0] = 0
  tpim.nvm_cells[0][1] = 0
  for (var i = 0; i < tpim.max_col; i += 1) {//无关col置为高阻态
    tpim.col_input_voltages[i] = high_resistance;
  }
  //开始逻辑编程
  tpim.row_input_voltages[0] = logic_line_v
  tpim.col_input_voltages[0] = rxor_in_v
  tpim.col_input_voltages[1] = rxor_in_v
  tpim.col_input_voltages[2] = rxor_out_v
  tpim.update_cell()
  console.log("rxor")
  console.log(tpim.nvm_cells[0][2] == 0)
  //----------------模拟计算---------------------
  tpim.nvm_cells[0][0] = 1
  tpim.nvm_cells[1][0] = 1
  for (var i = 0; i < tpim.max_row; i += 1) {
    tpim.row_input_voltages[i] = 0
  }
  tpim.row_input_voltages[0] = 0.18
  tpim.row_input_voltages[1] = 0.12
  tpim.update_cell()
  console.log(tpim.col_current[0] == 0.3)
  //----------------数据存取一致性---------------------
  tpim.row_input_voltages[0] = set_row_v
  tpim.col_input_voltages[2] = set_col_v
  tpim.update_cell()
  console.log(tpim.nvm_cells[0][2] == 1)
  tpim.row_input_voltages[0] = reset_row_v
  tpim.col_input_voltages[2] = reset_col_v
  tpim.update_cell()
  console.log(tpim.nvm_cells[0][2] == 0)
  //-----------------数据读入读出--------------------
  tpim.initzeros()
  tpim.write_to(67, 1, 1, 8)
  console.assert(tpim.get_int(1, 1, 8) == 67, "data write and read error.")
  tpim.write_to(2, 0, 0, 8)
  tpim.write_to(0, 1, 0, 8)
  tpim.write_to(47, 2, 0, 8)
  tpim.read_from_write(0, 0, 1, 0, 3, 0, 8)
  console.assert(tpim.get_int(3, 0, 8) == 47, "data indirect address error.")
  //-----------------移位累加器-------------------------
  tpim.set_high_resistance()
  tpim.write_to(12, 0, 0, 8)
  tpim.write_to(6, 1, 0, 8)
  tpim.row_input_voltages[0] = read_voltage//移位累加器读取
  tpim.row_input_voltages[1] = read_voltage
  tpim.shiftandadd_in_begin_column = 0
  tpim.shiftandadd_in_length = 8
  tpim.shiftandadd_in_to_col_addrs = 0
  tpim.shiftandadd_in_to_row_addrs = 8
  tpim.update_cell()
  tpim.logical_shift_and_add(8)
  console.assert(tpim.get_int(8, 0, 8) == 18, "shift&and read")
  //-----------------量化读取与输入----------------------
  tpim.set_high_resistance()
  tpim.write_to(9, 0, 0, 8)
  tpim.write_to(6, 1, 0, 8)
  tpim.set_number_voltage(0, 2)
  tpim.set_number_voltage(1, 5)//2*9+5*6=48
  tpim.shiftandadd_in_begin_column = 0
  tpim.shiftandadd_in_length = 8
  tpim.shiftandadd_in_to_col_addrs = 0
  tpim.shiftandadd_in_to_row_addrs = 8
  tpim.update_cell()
  tpim.shift_and_add(8)
  console.assert(tpim.get_int(8, 0, 8) == 48, "quantum shift&and read error.")
  //-----------------地址扩张：串口读取与输入----------------------
  tpim.write_to('3'.charCodeAt(0), 20, 1, 8)
  tpim.write_to('4'.charCodeAt(0), 20, 1, 8)
  //----------------地址扩张：列地址-1时上述各项写入电压缓存-----------
  tpim.set_high_resistance()
  tpim.nvm_cells[2][1] = 1
  tpim.write_to(4, 2, -1, 8)
  tpim.update_cell()
  tpim.shiftandadd_in_begin_column = 1
  tpim.shiftandadd_in_length = 1
  tpim.shiftandadd_in_to_col_addrs = 0
  tpim.shiftandadd_in_to_row_addrs = 3
  tpim.shift_and_add(8)
  console.assert(tpim.get_int(3, 0, 8) == 4, "write to -1 column")
  //---------------------------------功耗测试-------------------
  //------------------------------指令编解码测试（TODO）------------------------
  console.log("--------test instruction encoder and decoder-----------------")
  //存储相关指令编解码
  tpim.init_flash.push("write_bits 8 0 0 56")//[bits],[row],[col],[value]  
  tpim.init_flash.push("read_bits 8 0 0 1 0")//[bits],[row0],[col0],[trow],[tcol] 
  tpim.init_flash.push("write_bits 8 2 0 9")

  tpim.init_flash.push("write_bits 8 3 0 0")
  tpim.init_flash.push("write_bits 8 9 0 16")
  tpim.init_flash.push("indirect_write_bits 8 2 0 3 0 9 0")//[bits],[row_row],[row_col],[col_row],[col_col],[trow],[tcol],需要logic sa
  tpim.decode_init()
  console.assert(tpim.get_int(0, 0, 8) == 56, "memory write error")
  console.assert(tpim.get_int(1, 0, 8) == 56, "memory read error")
  console.assert(tpim.get_int(9, 0, 8) == 16, "memory error")
  console.assert(tpim.get_int(2, 0, 8) == 9, "memory write error")
  tpim.initzeros()
  //计算相关指令编解码(使用循环flash实现)
  tpim.dataflow_flash.push("write_bits 8 0 0 12")//2*12+3*21
  tpim.decoder_one_inst()

  tpim.dataflow_flash.push("write_bits 8 0 8 2")
  tpim.decoder_one_inst()
  tpim.dataflow_flash.push("write_bits 8 1 0 21")
  tpim.decoder_one_inst()
  tpim.dataflow_flash.push("write_bits 8 1 8 3")
  tpim.decoder_one_inst()
  tpim.dataflow_flash.push("clear_input")//清空输入
  tpim.decoder_one_inst()
  tpim.dataflow_flash.push("copy_bits 8 0 8 0 -1")//[bits],[row0],[col0],[trow],[tcol]
  tpim.decoder_one_inst()
  tpim.dataflow_flash.push("copy_bits 8 1 8 1 -1")
  tpim.decoder_one_inst()
  tpim.dataflow_flash.push("sa_number 8 0 0 8")//[bits],[col0],[trow],[tcol]
  tpim.decoder_one_inst()
  console.assert(tpim.get_int(0, 8, 8) == 2 * 12 + 3 * 21, "error in computing")
  //逻辑相关指令编解码
  console.log("------------test logic instructions-------------------")
  tpim.initzeros()
  tpim.write_logic_to(1, 0, 0)
  tpim.write_logic_to(1, 0, 1)
  tpim.dataflow_flash.push("nand3 2 0 5 0")//[bits],[col0],[tcol],[row]

  tpim.decoder_one_inst()

  console.assert(tpim.get_int(0, 5, 1) == 0, "nand error")
  tpim.write_logic_to(0, 1, 0)
  tpim.write_logic_to(0, 2, 0)
  tpim.write_logic_to(0, 3, 0)
  tpim.dataflow_flash.push("cor 3 1 6 0")//[bits],[row0],[trow],[col]
  tpim.decoder_one_inst()

  console.assert(tpim.get_int(6, 0, 1) == 0, "cor error")
  tpim.write_logic_to(1, 2, 0)
  tpim.dataflow_flash.push("cor 3 1 6 0")//[bits],[row0],[trow],[col]
  tpim.decoder_one_inst()
  console.assert(tpim.get_int(6, 0, 1) == 1, "cor error")
  tpim.dataflow_flash.push("cnor 3 1 6 0 ")//[bits],[row0],[trow],[col]
  tpim.decoder_one_inst()
  console.assert(tpim.get_int(6, 0, 1) == 0, "cnor error")
  tpim.write_logic_to(0, 2, 1)
  tpim.write_logic_to(0, 2, 2)
  tpim.write_logic_to(1, 2, 3)
  tpim.dataflow_flash.push("ror 3 1 9 2")//[bits],[col0],[tcol],[row]
  tpim.decoder_one_inst()

  console.assert(tpim.get_int(2, 9, 1) == 1, "ror error")
  tpim.dataflow_flash.push("rnor 3 1 9 2")//[bits],[col0],[tcol],[row]
  tpim.decoder_one_inst()
  console.assert(tpim.get_int(2, 9, 1) == 0, "rnor error")
  tpim.write_logic_to(0, 6, 2)
  tpim.write_logic_to(1, 6, 0)
  tpim.dataflow_flash.push("rxor 0 2 3 6")//[col0],[col1],[tcol],[row]
  tpim.decoder_one_inst()
  console.assert(tpim.get_int(6, 3, 1) == 1, "rxor error")
  tpim.nvm_cells[3][3] = 1
  tpim.write_logic_to(0, 2, 3)
  tpim.write_logic_to(0, 4, 3)
  tpim.dataflow_flash.push("cxor 4 2 3 3")//[row0],[row1],[trow],[col]
  tpim.decoder_one_inst()
  console.assert(tpim.get_int(3, 3, 1) == 0, "cxor error")

  console.log("------------test end--------------------")
}

//----------------Rendering----------------

var config = {
  content: [{
    type: 'row',
    content: [{
      type: 'column',
      content: [{
        type: 'component',
        title: 'Real Time Statistical Information',
        componentName: 'testComponent',
        componentState: { label: 'statisticalregion' }
      }, {
        type: 'row',
        content: [{
          type: 'component',
          title: 'Static Configuration',
          componentName: 'testComponent',
          componentState: { label: 'static' }
        }, {
          type: 'component',
          title: 'Real Time NVM Crossbar ',
          componentName: 'testComponent',
          componentState: { label: 'crossbar' }
        }, {
          type: 'component',
          title: 'Real Time TPIM Console',
          componentName: 'testComponent',
          componentState: { label: 'tpimconsole' }
        }
        ]
      },
      {
        type: 'row',

        content: [{
          type: 'component',
          title: 'Interactive Debugger(reconfigurable level)',
          componentName: 'testComponent',
          componentState: { label: 'interactive' }
        }, {
          type: 'component',
          width: 30,
          title: 'Serial Input/Output(OS level)',
          componentName: 'testComponent',
          componentState: { label: 'serial' }
        }
        ]
      }]
    }, {
      type: 'column',
      width: 30,
      content: [{
        type: 'component',
        title: "Turing Complete Memory Asssembly",
        id: "assembly",
        componentName: 'testComponent',
        componentState: { label: "asm" }
      }, {
        type: 'component',
        title: "Turing Complete Memory Constructor",
        componentName: 'testComponent',
        componentState: { label: 'cons' }
      }]
    }]
  }]
};

var crossbarconfig = `

<form class="row g-3 text-light" style="overflow-y:scroll;height:inherit;">
  <div class="col-md-6">
    <label for="inputEmail4" class="form-label" >Crossbar row number:</label>
    <input type="number" class="form-control" id="xbrow">
  </div>
  <div class="col-md-6">
    <label for="inputPassword4" class="form-label">Crossbar col number:</label>
    <input type="number" class="form-control" id="xbcol">
  </div>
  <div class="col-md-6">
    <label for="inputEmail4" class="form-label">Serial Input Address:</label>
    <input type="number" class="form-control" id="inputaddr">
  </div>
  <div class="col-md-6">
    <label for="inputPassword4" class="form-label">Serial Output Address:</label>
    <input type="number" class="form-control" id="outputaddr">
  </div>
  <div class="col-12">
    <label for="inputAddress" class="form-label">ADC number</label>
    <input type="number" class="form-control" id="adcnumber" placeholder="">
  </div>
  <div class="col-12">
    <label for="inputAddress2" class="form-label">Shift&Add number</label>
    <input type="number" class="form-control" id="sanumber" placeholder="">
  </div>
  <div class="col-12">
  <label for="inputAddress2" class="form-label">NVM Initial File</label>
  <input id="input-id" type="file" class="file" type="text/plain" data-preview-file-type="text">
  </div>
  <div class="col-6">
    <button type="submit" class="btn btn-primary" onclick="window.setfini()">Set Finished</button>
  </div>
</form>
`
var myLayout = new GoldenLayout(config, document.getElementById("nvm-simulator"));
myLayout.registerComponentFactoryFunction('testComponent', function (container, componentState) {
  if (componentState.label == "asm") {
    container.element.id = "monaco"//="<div id=\"monaco\"> </div>";
  }
  else if (componentState.label == "cons") {
    container.element.innerHTML = crossbarconfig
    container.element.setAttribute("overflow-y", "scroll")
  }
  else if (componentState.label == "crossbar") {
    container.element.innerHTML = `<canvas id="myCanvas" width="200" height="100"></canvas>`
  }
  else if (componentState.label == "tpimconsole") {

    container.element.id = "tpc"
  }
  else if (componentState.label == "static") {
    container.element.id = "staticfield"
    container.element.innerHTML=`
    <ul class="list-group" style="overflow-y:scroll;height:inherit;">
    <li class="list-group-item">Crossbar size:`+"Not running"+`</li>
    <li class="list-group-item">Serial output:`+"Not running"+`</li>
    <li class="list-group-item">Delta Interval:`+"Not running"+`</li>
    <li class="list-group-item" id="currentpc">Current PC:`+"Not running"+`</li>
    <li class="list-group-item" id="currentloc">Current Loc:`+"Not running"+`</li>
    <li class="list-group-item" id="currentinst">Current Inst:`+"Not running"+`</li>
  </ul>`
  }
  else if (componentState.label == "interactive") {
    container.element.id = "interactive"
  }
  else if (componentState.label == "serial") {
    container.element.id = "serial"
  }
  else if(componentState.label=="statisticalregion"){
    container.element.id = "statistical"

    container.element.style="background:white;"
  }
});

myLayout.init();

myLayout.resizeWithContainerAutomatically = true
function arrayBufferToBase64(buffer) {
  var binary = '';
  var bytes = new Uint8Array(buffer);
  var len = bytes.byteLength;
  for (var i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}


var asmvalue = localStorage.getItem("asm")
if (asmvalue == "") {
  asmvalue = `//Clear this comment and type your TPIM assembly`
}
const monacoInstance = monaco.editor.create(document.getElementById("monaco"), {
  value: asmvalue,
  language: "",
  theme: "vs-dark"

})
monacoInstance.onDidChangeCursorPosition = () => {
  asmvalue = monacoInstance.getValue()
  localStorage.setItem("asm", asmvalue)
}
const tpcconsole = monaco.editor.create(document.getElementById("tpc"), {
  value: `TPIM Console Output\n`,
  language: "",
  theme: "vs-dark",
  readOnly: true,
  automaticLayout: true,
  lineNumbers: "off",
  fixedOverflowWidgets: true,
  wordWrap: "on",
  minimap: {
    enabled: false, // 不要小地图
  },

})
tpcconsole.log = (value) => {
  tpcconsole.setValue(tpcconsole.getValue() + value)
}
var delta=30
const interactiveconsole = monaco.editor.create(document.getElementById("interactive"), {
  language: "javascript",
  theme: "vs-dark",
  automaticLayout: true,
  lineNumbers: "off",
  fixedOverflowWidgets: true,
  wordWrap: "on",
  minimap: {
    enabled: false, // 不要小地图
  }
})
var mytimeout = undefined
var ready = false
var breakpc=-1
interactiveconsole.onDidChangeCursorPosition(() => {
  var text = interactiveconsole.getValue().split(" ")
  console.log(text)
  if (text.find((item) => {
    return item.includes("\n")
  }) !== undefined) {
    if (text[0] == "show" && text.length == 4) {
      var bits = Number(text[1])
      var row = Number(text[2])
      var col = Number(text[3])
      tpcconsole.setValue(tpcconsole.getValue() + "\n" + "> " + text + pimsystem.get_int(row, col, bits))
    }
    else if(text[0]=="set"&&text.length==5){
      var bits = Number(text[1])
      var row = Number(text[2])
      var col = Number(text[3])
      var value=Number(text[4])
      tpcconsole.setValue(tpcconsole.getValue() + "\n" + "> " + text + pimsystem.write_to(value,row,col,bits))
    }
    else if(text[0]=="break"){
      var pc=Number(text[1])
      breakpc=pc
      tpcconsole.setValue(tpcconsole.getValue() + "\n" + "> " + text)
    }
    else if(text[0]=="clearbreak"){
      breakpc=-1
      tpcconsole.setValue(tpcconsole.getValue() + "\n" + "> " + text)
    }
    else if(text[0]=="setdelta"){
      delta=Number(text[1])
      tpcconsole.setValue(tpcconsole.getValue() + "\n" + "> " + text)
    }
    else{
      tpcconsole.setValue(tpcconsole.getValue() + "\n" + "> " + "undefined debug command"+"\n")
    }
    interactiveconsole.setValue("")
  }

})


const serial = monaco.editor.create(document.getElementById("serial"), {
  value: `TPIM Serial Console Output\n`,
  language: "",
  theme: "vs-dark",
  readOnly: true,
  automaticLayout: true,
  lineNumbers: "off",
  fixedOverflowWidgets: true,
  wordWrap: "on",
  minimap: {
    enabled: false, // 不要小地图
  },

})

$(document).ready(function () {
  // initialize with defaults
  // $("#input-id").fileinput();

  // with plugin options
  $("#input-id").fileinput({ maxFileCount: 1, 'showUpload': false, 'previewFileType': 'any', allowedFileExtensions: ['txt', 'nvm'], });
});

document.getElementById("input-id").addEventListener("change", () => {
  var f = document.getElementById("input-id");
  var reader = new FileReader();

  reader.readAsText(f.files[0]);//发起异步请求
  reader.onload = function () {
    //读取完成后，数据保存在对象的result属性中
    nvm_memory_file = this.result;
    localStorage.setItem("nvm_memory_file", nvm_memory_file)
  }
})
//实时监听汇编语言编辑器窗口变化
var muob = new MutationObserver((mutationsList, observer) => {
  monacoInstance.layout()
  myChart.resize()
})
muob.observe(document.getElementById("monaco"), { attributes: true })
var muob2 = new MutationObserver((mutationsList, observer) => {
  tpcconsole.layout()
  myChart.resize()
})
muob2.observe(document.getElementById("tpc"), { attributes: true })


window.stopasm=()=>{
  if (mytimeout != undefined) {
    clearInterval(mytimeout)
    mytimeout = undefined
  }
  pimsystem=undefined
  document.getElementById("currentpc").innerHTML="Current PC:"+"Not run"
      document.getElementById("currentloc").innerHTML="Current Loc:"+"Not run"
      document.getElementById("currentinst").innerHTML="Current Inst:"+"Not run"
}

//更新硬件参数
window.setfini = () => {
  localStorage.setItem("xb_row", $("#xbrow").val())
  localStorage.setItem("xb_col", $("#xbcol").val())
  localStorage.setItem("serial_input_address", $("#inputaddr").val())
  localStorage.setItem("serial_output_address", $("#outputaddr").val())
  localStorage.setItem("adc_number", $("#adcnumber").val())
  localStorage.setItem("sa_number", $("#sanumber").val())
}
window.addEventListener("load", () => {
  document.getElementById("xbrow").setAttribute("value", localStorage.getItem("xb_row"))
  document.getElementById("xbcol").setAttribute("value", localStorage.getItem("xb_col"))
  document.getElementById("inputaddr").setAttribute("value", localStorage.getItem("serial_input_address"))
  document.getElementById("outputaddr").setAttribute("value", localStorage.getItem("serial_output_address"))
  document.getElementById("adcnumber").setAttribute("value", localStorage.getItem("adc_number"))
  document.getElementById("sanumber").setAttribute("value", localStorage.getItem("sa_number"))
  nvm_memory_file = localStorage.getItem("nvm_memory_file")
  
})


window.pauseasm = () => {
  if (mytimeout != undefined) {
    clearInterval(mytimeout)
    mytimeout = undefined
  }
  else if (ready == true) {
    mytimeout = setInterval(myrun, delta)
  }
}



function myrun() {
  if((pimsystem.dataflow_flash_pc==pimsystem.dataflow_flash.length&&breakpc==0)||(breakpc==pimsystem.dataflow_flash_pc)){
    clearInterval(mytimeout)
    mytimeout = undefined
    return
  }

  if (pimsystem.dataflow_flash_pc >= pimsystem.dataflow_flash.length) {
    tpcconsole.log("running at " + 0 + ": " + pimsystem.dataflow_flash[0] + "\n")
  }
  else {
    tpcconsole.log("running at " + pimsystem.dataflow_flash_pc + ": " + pimsystem.dataflow_flash[pimsystem.dataflow_flash_pc] + "\n")
  }

  pimsystem.decoder_one_inst()


  //更新数据
  update()
}

window.runasm = () => {
  //停止前面run的线程
  if(mytimeout!=undefined){
    clearInterval(mytimeout)
    mytimeout = undefined
  }
  //创建TPIM对象
  pimsystem = new PIMSystem(parseInt(localStorage.getItem("xb_row")), parseInt(localStorage.getItem("xb_col")), parseInt(localStorage.getItem("adc_number")), parseInt(localStorage.getItem("sa_number")), parseInt(localStorage.getItem("serial_input_address")), parseInt(localStorage.getItem("serial_output_address")), serial)
  //加载参数、flash、NVM初始值
  var flashstring = monacoInstance.getValue()

  flashstring = flashstring.replace(/\r/g, "")
  var flash_list = flashstring.split("init.end\n")
  if (flash_list.length != 2) {
    tpcconsole.setValue(tpcconsole.getValue() + "Flash assembly error, it should divided into two parts.\n")
  }
  //flash初始化
  pimsystem.init_flash = flash_list[0].split("\n")
  pimsystem.dataflow_flash = flash_list[1].split("\n")
  pimsystem.dataflow_flash = pimsystem.dataflow_flash.filter((item) => {
    return item !== ""
  })
  pimsystem.init_flash = pimsystem.init_flash.filter((item) => {
    return item !== ""
  })
  //初始化nvm，要求nvm必须非空
  var nvm_array = nvm_memory_file.split(" ")
  nvm_array = nvm_array.map(i => Number(i))

  if (nvm_array.length != pimsystem.max_col * pimsystem.max_row) {
    alert("NVM Memory Load Error")
  }
  for (var i = 0; i < pimsystem.max_row; i++) {
    for (var j = 0; j < pimsystem.max_col; j++) {
      pimsystem.nvm_cells[i][j] = nvm_array[i * pimsystem.max_col + j]
    }
  }

  //显示静态信息
  document.getElementById("staticfield").innerHTML =`
  <ul class="list-group" style="overflow-y:scroll;height:inherit;">
  <li class="list-group-item">Crossbar size:`+pimsystem.max_row+"x"+pimsystem.max_col+`</li>
  <li class="list-group-item">Serial output:`+pimsystem.serialout+`</li>
  <li class="list-group-item">Delta Interval:`+delta+`</li>
  <li class="list-group-item" id="currentpc">Current PC:`+pimsystem.dataflow_flash_pc+`</li>
  <li class="list-group-item" id="currentloc">Current Loc:`+(pimsystem.dataflow_flash_pc+pimsystem.init_flash.length+2)+`</li>
  <li class="list-group-item" id="currentinst">Current Inst:`+pimsystem.dataflow_flash[pimsystem.dataflow_flash_pc]+`</li>
</ul>`

  //---------运行初始化flash中的代码------------------
  pimsystem.decode_init()
  //---------开始运行，每条指令后设一个桩，更新显示界面，pause时就暂停-------

  mytimeout = setInterval(myrun, delta);
  ready = true

}
window.cleartpimconsole = () => {
  tpcconsole.setValue("")
}
window.clearasm = () => {
  monacoInstance.setValue("")
}
testpim(serial)
var chartDom = document.getElementById('statistical');
var myChart = echarts.init(chartDom);
//注意：图表中不计算init_flash中的数据
var option;
option = {
  title: {
    text: 'Dynamic TPIM Monitor'
  },
  tooltip: {
    trigger: 'axis',
    axisPointer: {
      type: 'cross',
      label: {
        backgroundColor: '#6a7985'
      }
    }
  },
  legend: {
    data: ['Latency', 'Energy', 'Utility','Endurance']
  },
  toolbox: {
    feature: {
      saveAsImage: {}
    }
  },
  grid: {
    left: '3%',
    right: '4%',
    bottom: '3%',
    containLabel: true
  },
  xAxis: [
    {
      type: 'value',
      boundaryGap: false,
    }
  ],
  yAxis: [
    {
      type: 'value'
    }
  ],
  series: [
    {
      name: 'Latency',
      type: 'line',
      stack: 'Total',
      areaStyle: {},
      emphasis: {
        focus: 'series'
      },
      label: {
        show: true,	// 是否可见
        rotate: 0 	// 旋转角度
      },
      data: []
    },
    {
      name: 'Energy',
      type: 'line',
      stack: 'Total',
      areaStyle: {},
      emphasis: {
        focus: 'series'
      },
      data: []
    },
    {
      name: 'Utility',
      type: 'line',
      stack: 'Total',
      areaStyle: {},
      emphasis: {
        focus: 'series'
      },
      data: []
    },
    {
      name: 'Endurance',
      type: 'line',
      stack: 'Total',
      areaStyle: {},
      emphasis: {
        focus: 'series'
      },
      data: []
    }
  ]
};

option && myChart.setOption(option);

function update() {
  option.series[0].data.push({value:[pimsystem.total_inst_num,0]})//latency
  option.series[1].data.push({value:[pimsystem.total_inst_num,0]})//energy
  option.series[2].data.push({value:[pimsystem.total_inst_num,0]})//utility
  option.series[3].data.push({value:[pimsystem.total_inst_num,0]})//endurance
  myChart.setOption(option);
}
// monacoInstance.dispose();//使用完成销毁实例

//Principle 1: NN embedded as a basic block
//There are two scenes: cat and dog. Select cat neural object and render it on screen.
if 
//Principle 2: Function Programming on Scene&Image for Parallel
//Principle 3: auto gradient as a dataflow operator
//Principle 4: Sampling embedded as a basic probalistic operator
//Principle 5: Kernel as a trival function
//Principle 6: Scene graph&Image as the basic type
//Principle 7: Event&Logic programming for robotic animation
//Principle 8: Database as the distributed memory level